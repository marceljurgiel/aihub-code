"""Per-turn checkpoints for /undo: a shadow git repo, or plain file copies.

The shadow repo lives in the harness store (``<store>/shadow.git``) and is
only ever used as ``git --git-dir=<store>/shadow.git --work-tree=<root>``,
with no user or system config and no hooks, so the project's own ``.git`` is
never read or written. Snapshots honour the project's ``.gitignore``, the
repo's ``.git/info/exclude`` and a fixed exclude list; ignored files are never
snapshotted, so undo touches them only when a tool wrote them (below). Nested
repositories (and submodules) are excluded as well.

Undo is turn-scoped: it reverts only the paths the turn itself changed
(``start`` → ``end`` snapshot); paths changed after the turn are left alone,
and a turn path changed again since is a conflict. A turn without an ``end``
snapshot (failed or crashed) reverts start → now, with every path a conflict.
Anything undo can't put back safely is listed in ``UndoPlan.skipped``.

The runner also calls ``record_before(path)`` before each tool write and
``note_shell`` before each command in shadow mode: a tool write to an ignored
or excluded file (``.env``, ``build/``) is undone from that copy, and in a
turn that ran no command every changed path the tools didn't write was
changed by someone else meanwhile, so it is a conflict.

``state.json`` is shared with other aihub-code processes on the same project: it
is re-read and merged under a file lock before every decision and write.

When git is missing, too slow, the project too large, or git fails, the store
switches to "files" mode for the rest of the session: the runner calls
``record_before(path)`` before each write, and undo puts those bytes back.
Shell commands are not reverted in that mode, and the plan says so.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field

from .engine.filelock import file_lock

log = logging.getLogger(__name__)

EXCLUDES = (".git/", "node_modules/", ".venv/", "venv/", "__pycache__/",
            "target/", "dist/", "build/", ".next/", ".cache/")
# Overrides any .gitattributes in the project: snapshots and restores keep
# the exact bytes (no eol conversion, no $Id$ expansion, no filters).
ATTRIBUTES = "* -text -ident -filter -working-tree-encoding\n"
GIT_TIMEOUT = 30.0      # small git commands during a turn
UNDO_TIMEOUT = 120.0    # undo is user-initiated: allow a slow snapshot
RETRY_TIMEOUT = 30.0    # the one retry of a failed end snapshot
GC_TIMEOUT = 10.0
STALE_LOCK = 600.0      # an index.lock older than this is left over from a crash
CHUNK = 200             # paths per git command line
GITLINK = "160000"
NO_CHECKPOINT = "(no checkpoint was taken for this turn)"
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)


@dataclass
class UndoPlan:
    turn_id: str
    restore: list[str] = field(default_factory=list)
    delete: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    shell_not_reverted: list[str] = field(default_factory=list)
    mode: str = "shadow"
    skipped: list[str] = field(default_factory=list)


class UndoConflict(Exception):
    def __init__(self, plan: UndoPlan):
        super().__init__("changed outside AIhub since the turn: " + ", ".join(plan.conflicts))
        self.plan = plan


class NothingToUndo(Exception):
    pass


class CheckpointError(RuntimeError):
    """Undo could not be computed or applied."""


class _GitFailed(Exception):
    def __init__(self, reason: str, note: str, *, too_many: bool = False):
        super().__init__(reason)
        self.note = note
        self.too_many = too_many


_KEY = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9._-]*")


def _valid_entry(entry) -> bool:
    return (isinstance(entry, dict) and isinstance(entry.get("id"), str)
            and isinstance(entry.get("key"), str) and bool(_KEY.fullmatch(entry["key"]))
            and ".." not in entry["key"] and entry.get("mode") in ("shadow", "files"))


def _safe_key(turn_id: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", turn_id):
        return turn_id
    return "t-" + hashlib.sha1(turn_id.encode("utf-8", "surrogatepass")).hexdigest()[:16]


def _split_z(data: bytes) -> list[str]:
    return [os.fsdecode(p) for p in data.split(b"\0") if p]


def _exclude_pattern(rel: str) -> str | None:
    """An anchored .gitignore pattern matching exactly the directory `rel`."""
    rel = rel.rstrip("/")
    if not rel or "\n" in rel or "\r" in rel:
        return None
    return "/" + re.sub(r"([\\*?\[\] !#])", r"\\\1", rel) + "/"


def _lstat(path: str) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return None


def _readlink(path: str) -> str:
    """A symlink's target as it was written. Windows' readlink adds the
    long-path prefix ("\\\\?\\C:\\..."); a link restored with it would point at
    the same file under a different target string."""
    target = os.readlink(path)
    if sys.platform == "win32":
        if target.startswith("\\\\?\\UNC\\"):
            return "\\\\" + target[8:]
        if target.startswith("\\\\?\\"):
            return target[4:]
    return target


def _fingerprint(path: str) -> str | None:
    """What is at `path`, without following symlinks: None when absent."""
    try:
        st = os.lstat(path)
        if stat.S_ISLNK(st.st_mode):
            return "link:" + _readlink(path)
        if stat.S_ISDIR(st.st_mode):
            return "dir"
        if not stat.S_ISREG(st.st_mode):
            return "special"
        h = hashlib.sha256()
        with os.fdopen(os.open(path, os.O_RDONLY | _NOFOLLOW), "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        return h.hexdigest()
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:
        return "unreadable"


def _write_json(path: str, data) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


def _read_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


class CheckpointStore:
    def __init__(self, root: str, store: str, *, time_budget: float = 3.0,
                 max_files: int = 20000, keep: int = 20):
        self.root = os.path.realpath(root)
        self.store = os.path.abspath(store)
        self.time_budget = time_budget
        self.max_files = max_files
        self.keep = keep
        self.mode = "shadow"
        self.note = ""
        self._lock = threading.RLock()
        self._shadow = os.path.join(self.store, "shadow.git")
        self._cp_dir = os.path.join(self.store, "checkpoints")
        self._state_path = os.path.join(self._cp_dir, "state.json")
        self._empty = os.path.join(self.store, "empty.gitconfig")
        self._nested = os.path.join(self.store, "nested.exclude")
        self._turn: dict | None = None       # the running turn's state entry
        self._manifest: dict | None = None   # the running turn's file copies and commands
        self._owned: set[str] = set()        # turn keys this process created or undid
        self._dropped: set[str] = set()      # turn keys this process pruned
        self._persisted: set[str] = set()    # turn keys seen in state.json
        self._git_bin: str | None = None
        self._state: dict = {"turns": []}
        try:
            os.makedirs(self._cp_dir, exist_ok=True)
        except OSError as exc:
            log.warning("checkpoint store %s unusable: %s", self.store, exc)
            self._fallback(f"checkpoints are off ({exc.strerror or exc})")
            return
        state = _read_json(self._state_path, None)
        if isinstance(state, dict) and isinstance(state.get("turns"), list):
            turns = [t for t in state["turns"] if _valid_entry(t)]
            if len(turns) != len(state["turns"]):
                log.warning("dropped %d invalid turn entries from %s",
                            len(state["turns"]) - len(turns), self._state_path)
            self._state = {"turns": turns}
        self._git_bin = shutil.which("git")
        if not self._git_bin:
            self._fallback("git is not installed; undo uses file copies and can't revert shell commands")
            return
        try:
            self._init_shadow()
        except _GitFailed as exc:
            self._fallback(exc.note)

    # -- git plumbing -----------------------------------------------------

    def _env(self) -> dict:
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
        env.update({
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_CONFIG_GLOBAL": self._empty,
            "GIT_CONFIG_SYSTEM": self._empty,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_LITERAL_PATHSPECS": "1",
        })
        return env

    def _git(self, *args: str, timeout: float = GIT_TIMEOUT, excludes: str | None = None,
             repo: bool = True) -> bytes:
        where = [f"--git-dir={self._shadow}", f"--work-tree={self.root}"] if repo else []
        cmd = [
            self._git_bin or "git", *where,
            "-c", "core.autocrlf=false", "-c", "core.safecrlf=false",
            "-c", "core.quotepath=false", "-c", f"core.hooksPath={os.path.join(self.store, 'hooks-off')}",
            "-c", "user.name=AIhub", "-c", "user.email=aihub@localhost",
            "-c", "core.fsmonitor=false", "-c", "core.logAllRefUpdates=false",
            "-c", "gc.autoDetach=false",
            "-c", f"core.excludesFile={excludes or self._nested}",
            *args,
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False,
                                  cwd=self.store, env=self._env())
        except subprocess.TimeoutExpired:
            self._drop_index_lock(0)
            raise _GitFailed(f"git {args[0]} timed out",
                             f"the snapshot took longer than {self.time_budget:g} s; undo uses file copies")
        except OSError as exc:
            raise _GitFailed(str(exc), f"git could not run ({exc}); undo uses file copies")
        if proc.returncode != 0:
            msg = proc.stderr.decode("utf-8", "replace").strip().splitlines()
            last = msg[-1] if msg else f"exit {proc.returncode}"
            raise _GitFailed(f"git {args[0]}: {last}", f"shadow git failed ({last}); undo uses file copies")
        return proc.stdout

    def _drop_index_lock(self, older_than: float) -> None:
        lock = os.path.join(self._shadow, "index.lock")
        try:
            if time.time() - os.path.getmtime(lock) >= older_than:
                os.remove(lock)
        except OSError:
            pass

    def _init_shadow(self) -> None:
        try:
            os.makedirs(os.path.join(self.store, "hooks-off"), exist_ok=True)
            for path in (self._empty, self._nested):
                if not os.path.exists(path):
                    open(path, "wb").close()
            if not os.path.isfile(os.path.join(self._shadow, "HEAD")):
                self._git("init", "-q", "--bare", "--template=", self._shadow, repo=False)
            info = os.path.join(self._shadow, "info")
            os.makedirs(info, exist_ok=True)
            with open(os.path.join(info, "attributes"), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(ATTRIBUTES)
            self._write_excludes()
        except OSError as exc:
            raise _GitFailed(str(exc), f"shadow git failed ({exc}); undo uses file copies")
        self._drop_index_lock(STALE_LOCK)

    def _exclude_data(self) -> bytes:
        """The fixed list + the project repo's own .git/info/exclude."""
        data = ("\n".join(EXCLUDES) + "\n").encode()
        user = os.path.join(self.root, ".git", "info", "exclude")
        if os.path.isdir(os.path.join(self.root, ".git")) and os.path.isfile(user):
            with open(user, "rb") as fh:
                data += b"# from the project's .git/info/exclude\n" + fh.read() + b"\n"
        return data

    def _exclude_hash(self) -> str:
        try:
            return hashlib.sha1(self._exclude_data()).hexdigest()
        except OSError:
            return "unreadable"

    def _write_excludes(self) -> None:
        """info/exclude = the fixed list + the project repo's own .git/info/exclude."""
        data = self._exclude_data()
        path = os.path.join(self._shadow, "info", "exclude")
        try:
            with open(path, "rb") as fh:
                if fh.read() == data:
                    return
        except OSError:
            pass
        with open(path, "wb") as fh:
            fh.write(data)

    def _chunked(self, args: tuple[str, ...], paths: list[str], timeout: float) -> None:
        for i in range(0, len(paths), CHUNK):
            self._git(*args, "--", *paths[i:i + CHUNK], timeout=timeout)

    def _snapshot(self, message: str, *, budget: float | None = None, count: bool = True) -> str:
        """Commit the work tree as it is now; return the commit id.

        The whole snapshot must fit in `budget` (default `time_budget`);
        `count` applies the `max_files` guard.
        """
        deadline = time.monotonic() + (self.time_budget if budget is None else budget)

        def left() -> float:
            return max(0.05, deadline - time.monotonic())

        try:
            self._write_excludes()
        except OSError as exc:
            raise _GitFailed(str(exc), f"shadow git failed ({exc}); undo uses file copies")
        listing = _split_z(self._git("ls-files", "-z", "-c", "-o", "--exclude-standard",
                                     timeout=left(), excludes=self._empty))
        # Without --directory, git lists a directory only when it is a nested
        # repository; those must never be added (an empty one fails `add`).
        nested = [p for p in listing if p.endswith("/")]
        if count and len(listing) - len(nested) > self.max_files:
            raise _GitFailed("too many files",
                             f"the project has more than {self.max_files} files; undo uses file copies",
                             too_many=True)
        patterns = [pat for pat in map(_exclude_pattern, nested) if pat]
        try:
            with open(self._nested, "w", encoding="utf-8", newline="\n", errors="surrogateescape") as fh:
                fh.write("".join(pat + "\n" for pat in patterns))
        except OSError as exc:
            raise _GitFailed(str(exc), f"shadow git failed ({exc}); undo uses file copies")
        # Files tracked by an earlier snapshot that are ignored now leave the
        # shadow index, so undo never touches them.
        ignored = _split_z(self._git("ls-files", "-z", "-c", "-i", "--exclude-standard", timeout=left()))
        for i in range(0, len(ignored), CHUNK):
            self._git("rm", "--cached", "-q", "--ignore-unmatch", "-r", "--", *ignored[i:i + CHUNK],
                      timeout=left())
        self._git("add", "-A", timeout=left())
        tree = self._git("write-tree", timeout=left()).decode().strip()
        return self._git("commit-tree", tree, "-m", message, timeout=left()).decode().strip()

    def _ref(self, key: str, name: str) -> str:
        return f"refs/aihub/{key}/{name}"

    def _set_ref(self, key: str, name: str, commit: str) -> None:
        self._git("update-ref", self._ref(key, name), commit)

    def _resolve(self, key: str, name: str) -> str | None:
        try:
            return self._git("rev-parse", "-q", "--verify", self._ref(key, name) + "^{commit}",
                             timeout=UNDO_TIMEOUT).decode().strip()
        except _GitFailed:
            return None

    def _drop_refs(self, key: str) -> bool:
        dropped = False
        for name in ("start", "end", "undo"):
            try:
                self._git("update-ref", "-d", self._ref(key, name))
                dropped = True
            except _GitFailed:
                pass
        return dropped

    def _diff(self, a: str, b: str) -> dict[str, tuple[str, bool]]:
        """path -> (status letter, is a nested repo) for paths differing between commits."""
        out = self._git("diff-tree", "-r", "-z", "--no-renames", a, b, timeout=UNDO_TIMEOUT).split(b"\0")
        result = {}
        for i in range(0, len(out) - 1, 2):
            meta = out[i].decode("ascii", "replace").lstrip(":").split()
            if len(meta) >= 5:
                result[os.fsdecode(out[i + 1])] = (meta[4][:1], GITLINK in meta[:2])
        return result

    # -- mode switching and state -----------------------------------------

    def _fallback(self, note: str) -> None:
        self.mode = "files"
        self.note = note

    def _disk_turns(self) -> list | None:
        state = _read_json(self._state_path, None)
        if not isinstance(state, dict) or not isinstance(state.get("turns"), list):
            return None
        return [t for t in state["turns"] if _valid_entry(t)]

    def _merge(self, disk: list | None) -> None:
        """Take in turns other processes wrote. The disk's order and entries
        win, except for the turns this process created or undid (an undo
        on disk still wins, unless the key was begun again since: a new
        `begun` token); the running turn stays last; turns this process
        pruned stay gone."""
        if disk is None:
            return
        mine = {t["key"]: t for t in self._state["turns"]}
        running = self._turn["key"] if self._turn is not None else None
        out, seen = [], set()
        for d in disk:
            k = d["key"]
            self._persisted.add(k)
            if k in seen or k == running or k in self._dropped:
                continue
            seen.add(k)
            m = mine.get(k)
            if k in self._owned and m is not None and m.get("begun") == d.get("begun"):
                if d.get("undone"):
                    m["undone"] = True
                out.append(m)
            else:
                out.append(d)
        # Our turns whose save failed are kept; ours that were saved and
        # are gone now were pruned by another process.
        out += [t for t in self._state["turns"] if t["key"] in self._owned and t["key"] not in seen
                and t["key"] != running and t["key"] not in self._persisted]
        if self._turn is not None:
            out.append(self._turn)
        self._state["turns"] = out

    def _state_lock(self):
        return file_lock(os.path.join(self._cp_dir, "state.lock"))

    def _sync(self) -> None:
        try:
            with self._state_lock():
                self._merge(self._disk_turns())
        except OSError as exc:
            log.warning("could not read checkpoint state %s: %s", self._state_path, exc)

    def _save_state(self) -> None:
        try:
            with self._state_lock():
                self._merge(self._disk_turns())
                _write_json(self._state_path, self._state)
                self._persisted.update(t["key"] for t in self._state["turns"])
        except OSError as exc:
            log.warning("could not save checkpoint state %s: %s", self._state_path, exc)

    def _turn_dir(self, key: str) -> str:
        return os.path.join(self._cp_dir, key)

    def _new_manifest(self, entry: dict) -> OSError | None:
        try:
            os.makedirs(os.path.join(self._turn_dir(entry["key"]), "blobs"), exist_ok=True)
        except OSError as exc:
            log.warning("file checkpoints unavailable: %s", exc)
            self._manifest = None
            return exc
        self._manifest = {"turn": entry["id"], "files": [], "shell": [], "finished": False}
        self._write_manifest(entry["key"])
        return None

    def _start_manifest(self, entry: dict) -> None:
        entry["mode"] = "files"
        exc = self._new_manifest(entry)
        if exc is not None:
            self.note = f"checkpoints are off ({exc.strerror or exc})"

    def _write_manifest(self, key: str) -> None:
        path = os.path.join(self._turn_dir(key), "manifest.json")
        try:
            _write_json(path, self._manifest)
        except OSError as exc:
            log.warning("could not save checkpoint manifest %s: %s", path, exc)

    def _rel(self, path: str) -> str | None:
        full = os.path.abspath(os.path.join(self.root, path))
        # Resolve symlinked parent directories, not the file itself.
        full = os.path.join(os.path.realpath(os.path.dirname(full)), os.path.basename(full))
        try:
            rel = os.path.relpath(full, self.root)
        except ValueError:  # another drive on Windows
            return None
        if rel == "." or rel == os.pardir or rel.startswith(os.pardir + os.sep):
            return None
        return rel.replace(os.sep, "/")

    def _full(self, rel: str) -> str | None:
        """The on-disk path for a project-relative path, or None if it is malformed."""
        parts = rel.split("/")
        if not rel or os.path.isabs(rel) or any(p in ("", ".", "..") for p in parts):
            return None
        return os.path.join(self.root, *parts)

    def _parents_ok(self, rel: str, gone: set[str]) -> bool:
        """Every existing parent of `rel` is a real directory (not a symlink or a
        file), except one that undo deletes first."""
        parts = rel.split("/")
        cur = self.root
        for i, part in enumerate(parts[:-1]):
            cur = os.path.join(cur, part)
            try:
                st = os.lstat(cur)
            except FileNotFoundError:
                return True
            except OSError:
                return False
            if not stat.S_ISDIR(st.st_mode):
                return "/".join(parts[:i + 1]) in gone
        return True

    @staticmethod
    def _under(rel: str, gone: set[str]) -> bool:
        """True when a parent directory of `rel` is a path undo deletes first."""
        parts = rel.split("/")
        return any("/".join(parts[:i]) in gone for i in range(1, len(parts)))

    def _clears(self, full: str, rel: str, gone: set[str]) -> bool:
        """True when the directory at `full` holds nothing but paths undo deletes."""
        def fail(exc):
            raise exc

        try:
            for dirpath, dirs, files in os.walk(full, onerror=fail):
                links = [d for d in dirs if os.path.islink(os.path.join(dirpath, d))]
                for name in files + links:
                    sub = os.path.relpath(os.path.join(dirpath, name), full).replace(os.sep, "/")
                    if f"{rel}/{sub}" not in gone:
                        return False
        except OSError:
            return False
        return True

    def _classify(self, changes: dict[str, str], in_now: dict[str, bool] | None):
        """Split wanted changes ("restore"/"delete"/"skip") into what undo can do
        safely. `in_now`: whether a path is in the "now" snapshot (shadow mode);
        an existing path that is not is ignored now, so it is left alone."""
        def ours(p: str) -> bool:
            return in_now is None or in_now.get(p, False)

        restore, delete, skipped = [], [], [p for p, k in changes.items() if k == "skip"]
        for p in sorted(p for p, k in changes.items() if k == "delete"):
            full = self._full(p)
            if full is None or not self._parents_ok(p, set()):
                skipped.append(p)
                continue
            try:
                st = _lstat(full)
            except OSError:
                skipped.append(p)
                continue
            if st is None:
                continue
            elif stat.S_ISDIR(st.st_mode) or not ours(p):
                skipped.append(p)
            else:
                delete.append(p)
        gone = set(delete)
        for p in sorted(p for p, k in changes.items() if k == "restore"):
            full = self._full(p)
            if full is None or not self._parents_ok(p, gone):
                skipped.append(p)
                continue
            if self._under(p, gone):
                # A parent link or file is deleted first; looking now would
                # see through the link into its target.
                restore.append(p)
                continue
            try:
                st = _lstat(full)
            except OSError:
                skipped.append(p)
                continue
            if st is None:
                restore.append(p)
            elif stat.S_ISDIR(st.st_mode):
                (restore if self._clears(full, p, gone) else skipped).append(p)
            elif ours(p):
                restore.append(p)
            else:
                skipped.append(p)
        return restore, delete, sorted(skipped)

    # -- public API -------------------------------------------------------

    def begin_turn(self, turn_id: str) -> None:
        with self._lock:
            self._sync()
            key = _safe_key(turn_id)
            reused = any(t.get("key") == key for t in self._state["turns"])
            turns = [t for t in self._state["turns"] if t.get("key") != key]
            entry = {"id": turn_id, "key": key, "mode": self.mode, "undone": False, "finished": False,
                     "begun": secrets.token_hex(4)}
            turns.append(entry)
            self._state["turns"] = turns
            self._turn, self._manifest = entry, None
            self._owned.add(key)
            self._dropped.discard(key)
            shutil.rmtree(self._turn_dir(key), ignore_errors=True)
            if self.mode == "shadow":
                try:
                    if reused:
                        self._drop_refs(key)
                    self._set_ref(key, "start", self._snapshot(turn_id))
                except _GitFailed as exc:
                    self._fallback(exc.note)
            if self.mode == "files":
                self._start_manifest(entry)
            else:
                # Copies of tool-written files git doesn't track, the
                # commands the turn ran, and the exclude rules it began with.
                self._new_manifest(entry)
                if self._manifest is not None:
                    self._manifest["excludes"] = [self._exclude_hash()]
                    self._write_manifest(key)
            self._save_state()

    def record_before(self, path: str) -> None:
        with self._lock:
            if self._turn is None or self._manifest is None:
                return
            rel = self._rel(path)
            if rel is None or any(f["path"] == rel for f in self._manifest["files"]):
                return
            full = os.path.join(self.root, *rel.split("/"))
            item: dict = {"path": rel, "kind": "absent", "after": None}
            try:
                st = _lstat(full)
            except OSError:
                st = None
                item["kind"] = "lost"
            if st is not None and stat.S_ISLNK(st.st_mode):
                try:
                    item.update(kind="link", target=_readlink(full))
                except OSError:
                    item["kind"] = "lost"
            elif st is not None and stat.S_ISREG(st.st_mode):
                blob = str(len(self._manifest["files"]))
                try:
                    shutil.copyfile(full, os.path.join(self._turn_dir(self._turn["key"]), "blobs", blob),
                                    follow_symlinks=False)
                    item.update(kind="file", blob=blob, mode=st.st_mode & 0o7777)
                except OSError as exc:
                    log.warning("could not keep a copy of %s: %s", full, exc)
                    item["kind"] = "lost"
            elif st is not None:
                item["kind"] = "lost"  # a directory or a special file: nothing to copy
            if item["kind"] == "lost":
                item["before"] = _fingerprint(full)
            self._manifest["files"].append(item)
            self._write_manifest(self._turn["key"])

    def note_shell(self, command: str) -> None:
        with self._lock:
            if self._turn is not None and self._manifest is not None:
                self._manifest["shell"].append(command)
                self._write_manifest(self._turn["key"])

    def finish_turn(self) -> None:
        with self._lock:
            entry = self._turn
            if entry is None:
                return
            if entry["mode"] == "shadow":
                self._finish_shadow(entry)
            if self._manifest is not None:
                if isinstance(self._manifest.get("excludes"), list):
                    self._manifest["excludes"].append(self._exclude_hash())
                for item in self._manifest["files"]:
                    item["after"] = _fingerprint(os.path.join(self.root, *item["path"].split("/")))
                self._manifest["finished"] = True
                self._write_manifest(entry["key"])
                if entry["mode"] == "files":
                    entry["finished"] = True
            self._turn, self._manifest = None, None
            self._prune()
            self._save_state()

    def _finish_shadow(self, entry: dict) -> None:
        try:
            end = self._snapshot(entry["id"] + " end")
        except _GitFailed as exc:
            self._fallback(exc.note)
            if exc.too_many:
                log.warning("no end snapshot for turn %s: %s", entry["id"], exc)
                return
            # One slower try: without an end snapshot undo can't tell the
            # turn's changes from later ones.
            try:
                end = self._snapshot(entry["id"] + " end", budget=RETRY_TIMEOUT)
            except _GitFailed:
                log.warning("no end snapshot for turn %s: %s", entry["id"], exc)
                return
        try:
            self._set_ref(entry["key"], "end", end)
            entry["finished"] = True
        except _GitFailed as exc:
            log.warning("no end snapshot for turn %s: %s", entry["id"], exc)

    def _prune(self) -> None:
        turns = self._state["turns"]
        cut = len(turns) - max(self.keep, 0)
        if cut <= 0:
            return
        old, self._state["turns"] = turns[:cut], turns[cut:]
        pruned_refs = False
        for entry in old:
            self._dropped.add(entry["key"])
            shutil.rmtree(self._turn_dir(entry["key"]), ignore_errors=True)
            if entry.get("mode") == "shadow" and self._git_bin:
                pruned_refs = self._drop_refs(entry["key"]) or pruned_refs
        if pruned_refs:
            try:
                self._git("gc", "--auto", "--quiet", timeout=GC_TIMEOUT)
            except _GitFailed:
                pass

    def _last_turn(self) -> dict:
        for entry in reversed(self._state["turns"]):
            if not entry.get("undone"):
                return entry
        raise NothingToUndo("nothing to undo")

    def undo_plan(self) -> UndoPlan:
        with self._lock:
            self._sync()
            return self._plan(self._last_turn())[0]

    def _plan(self, entry: dict) -> tuple[UndoPlan, tuple[str, str] | None, set[str]]:
        """(plan, (start, now) commits in shadow mode, paths restored from copies)."""
        if entry.get("mode") == "files":
            plan = self._files_plan(entry)
            return plan, None, set(plan.restore)
        return self._shadow_plan(entry)

    def _tracked(self, commit: str, paths: list[str]) -> set[str]:
        out: set[str] = set()
        for i in range(0, len(paths), CHUNK):
            out.update(_split_z(self._git("ls-tree", "-r", "-z", "--name-only", commit, "--",
                                          *paths[i:i + CHUNK], timeout=UNDO_TIMEOUT)))
        return out

    def _ignore_rules_changed(self, turn: dict, manifest: dict | None) -> bool:
        """The turn changed a .gitignore, or the repo's info/exclude."""
        if any(p == ".gitignore" or p.endswith("/.gitignore") for p in turn):
            return True
        ex = manifest.get("excludes") if manifest else None
        if not isinstance(ex, list) or not ex:
            return False
        return ex[0] != (ex[1] if len(ex) > 1 else self._exclude_hash())

    def _side_manifest(self, entry: dict) -> dict | None:
        """A shadow turn's copies and commands, or None (older turns, a
        failed write): then undo treats it as a turn that ran a command."""
        manifest = _read_json(os.path.join(self._turn_dir(entry["key"]), "manifest.json"), None)
        if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), list):
            return None
        manifest["files"] = [f for f in manifest["files"] if isinstance(f, dict)
                             and isinstance(f.get("path"), str) and isinstance(f.get("kind"), str)]
        return manifest

    def _shadow_plan(self, entry: dict) -> tuple[UndoPlan, tuple[str, str], set[str]]:
        if not self._git_bin:
            raise CheckpointError("git is not installed; this turn was saved in a shadow git repo")
        key = entry["key"]
        start = self._resolve(key, "start")
        if start is None:
            raise CheckpointError(f"the snapshot for turn {entry['id']} is missing")
        try:
            now = self._snapshot(entry["id"] + " now", budget=UNDO_TIMEOUT, count=False)
            end = self._resolve(key, "end") if entry.get("finished") else None
            if end:
                turn = self._diff(start, end)
                after = self._diff(end, now)
                conflicts = sorted(set(turn) & set(after))
                in_now = {p: (after[p][0] if p in after else st) != "D" for p, (st, _g) in turn.items()}
            else:
                # No end snapshot: the turn's changes can't be told from later
                # ones, so everything since the start is a conflict.
                turn = self._diff(start, now)
                conflicts = sorted(turn)
                in_now = {p: st != "D" for p, (st, _g) in turn.items()}
            changes = {p: "skip" if gitlink else ("delete" if st == "A" else "restore")
                       for p, (st, gitlink) in turn.items()}
            copies: set[str] = set()
            manifest = self._side_manifest(entry)
            if manifest is not None:
                items = manifest["files"]
                recorded = {f["path"] for f in items}
                if end and not manifest.get("shell"):
                    # No command ran: the tools changed only what they
                    # recorded; anything else was someone else's edit.
                    conflicts = sorted(set(conflicts) | {p for p in turn if p not in recorded})
                maybe = sorted(recorded - set(turn))
                if maybe:
                    # Tool-written paths git never saw (ignored or excluded).
                    seen = self._tracked(start, maybe) | self._tracked(end or now, maybe)
                    extra, more = self._copy_changes(
                        entry, [f for f in items if f["path"] in maybe and f["path"] not in seen],
                        bool(end) and bool(manifest.get("finished")))
                    changes.update(extra)
                    conflicts = sorted(set(conflicts) | set(more))
                    in_now.update({p: True for p in extra})
                    copies = {p for p, k in extra.items() if k == "restore"}
            if self._ignore_rules_changed(turn, manifest):
                # Paths new to git may have existed all along, ignored: never
                # delete them silently (R34). A pre-turn copy puts them back.
                rec = {f["path"]: f for f in manifest["files"]} if manifest else {}
                more = set()
                for p, (st, gitlink) in turn.items():
                    if st != "A" or gitlink:
                        continue
                    kind = rec[p]["kind"] if p in rec else None
                    if kind in ("file", "link"):
                        changes[p] = "restore"
                        copies.add(p)
                        in_now[p] = True
                    elif kind != "absent":      # "absent": the tools created it
                        more.add(p)
                conflicts = sorted(set(conflicts) | more)
        except _GitFailed as exc:
            raise CheckpointError(str(exc)) from exc
        restore, delete, skipped = self._classify(changes, in_now)
        plan = UndoPlan(entry["id"], restore, delete, conflicts, [], "shadow", skipped)
        return plan, (start, now), copies & set(restore)

    def _load_manifest(self, entry: dict) -> dict:
        manifest = _read_json(os.path.join(self._turn_dir(entry["key"]), "manifest.json"), None)
        if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), list):
            raise CheckpointError(f"the file copies for turn {entry['id']} are missing")
        return manifest

    def _before(self, entry: dict, item: dict) -> str | None:
        if item["kind"] == "link":
            return "link:" + item["target"]
        if item["kind"] == "file":
            return _fingerprint(os.path.join(self._turn_dir(entry["key"]), "blobs", item["blob"]))
        return None

    def _files_plan(self, entry: dict) -> UndoPlan:
        if not os.path.exists(os.path.join(self._turn_dir(entry["key"]), "manifest.json")):
            # Checkpoints were off for this turn: nothing can be restored, but
            # it must not block undoing the turns before it.
            return UndoPlan(entry["id"], mode="files", skipped=[NO_CHECKPOINT])
        manifest = self._load_manifest(entry)
        changes, conflicts = self._copy_changes(entry, manifest["files"], bool(manifest.get("finished")))
        restore, delete, skipped = self._classify(changes, None)
        return UndoPlan(entry["id"], restore, delete, sorted(conflicts),
                        list(manifest.get("shell", [])), "files", skipped)

    def _copy_changes(self, entry: dict, items: list[dict],
                      finished: bool) -> tuple[dict[str, str], list[str]]:
        """What undo does with recorded copies: path -> restore/delete/skip,
        and the paths changed since the turn ended (all of them when it
        never finished)."""
        changes, conflicts = {}, []
        for item in items:
            path = item["path"]
            full = self._full(path)
            current = _fingerprint(full) if full else None
            if item["kind"] == "lost":
                if full is None or current != item.get("before") or current == "unreadable":
                    changes[path] = "skip"
                continue
            if full is None:
                changes[path] = "skip"
                continue
            if current == self._before(entry, item):
                continue
            changes[path] = "delete" if item["kind"] == "absent" else "restore"
            if finished and current != item.get("after"):
                conflicts.append(path)
        if not finished:
            conflicts = [p for p, k in changes.items() if k != "skip"]
        return changes, conflicts

    def undo(self, force: bool = False) -> UndoPlan:
        with self._lock:
            self._sync()
            entry = self._last_turn()
            plan, commits, copies = self._plan(entry)
            if plan.conflicts and not force:
                raise UndoConflict(plan)
            failed = self._delete(plan.delete)
            restore = []
            for rel in plan.restore:
                # After the deletes every existing parent must be a real
                # directory; otherwise a failed delete left a link in the way.
                if not self._parents_ok(rel, set()):
                    failed.append(f"{rel}: a parent is not a directory")
                    continue
                restore.append(rel)
                full = os.path.join(self.root, *rel.split("/"))
                if os.path.isdir(full) and not os.path.islink(full):  # took a file's place
                    failed += self._remove_empty_tree(rel, full)
            from_git = [p for p in restore if p not in copies]
            if commits is not None:
                start, now = commits
                if from_git:
                    try:
                        self._chunked(("checkout", start), from_git, UNDO_TIMEOUT)
                    except _GitFailed as exc:
                        failed.append(str(exc))
                try:
                    self._set_ref(entry["key"], "undo", now)
                except _GitFailed:
                    pass
            from_copies = [p for p in restore if p in copies]
            if from_copies:
                failed += self._restore_files(entry, from_copies)
            if failed:
                raise CheckpointError("undo was incomplete: " + "; ".join(failed))
            entry["undone"] = True
            self._owned.add(entry["key"])
            self._save_state()
            return plan

    def _delete(self, paths: list[str]) -> list[str]:
        failed = []
        for rel in paths:
            if not self._parents_ok(rel, set()):
                failed.append(f"{rel}: a parent is not a directory")
                continue
            try:
                os.remove(os.path.join(self.root, *rel.split("/")))
            except FileNotFoundError:
                pass
            except OSError as exc:
                failed.append(f"{rel}: {exc.strerror or exc}")
        return failed

    def _remove_empty_tree(self, rel: str, full: str) -> list[str]:
        try:
            for dirpath, _dirs, _files in os.walk(full, topdown=False):
                os.rmdir(dirpath)
        except OSError as exc:
            return [f"{rel}: {exc.strerror or exc}"]
        return []

    def _restore_files(self, entry: dict, paths: list[str]) -> list[str]:
        manifest = self._load_manifest(entry)
        blobs = os.path.join(self._turn_dir(entry["key"]), "blobs")
        by_path = {item["path"]: item for item in manifest["files"]}
        failed = []
        for rel in paths:
            item = by_path[rel]
            full = os.path.join(self.root, *rel.split("/"))
            try:
                if _lstat(full) is not None:
                    os.remove(full)  # unlink first: never write through a symlink
                os.makedirs(os.path.dirname(full), exist_ok=True)
                if item["kind"] == "link":
                    os.symlink(item["target"], full)
                    continue
                fd = os.open(full, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as out, open(os.path.join(blobs, item["blob"]), "rb") as src:
                    shutil.copyfileobj(src, out)
                os.chmod(full, item.get("mode") or 0o644)
            except OSError as exc:
                failed.append(f"{rel}: {exc.strerror or exc}")
        return failed
