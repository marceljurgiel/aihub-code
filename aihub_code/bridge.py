"""
aihub-code NDJSON stdio bridge.

Exposes a coding session to a front-end (the interactive UI, not built yet) over
newline-delimited JSON on stdin/stdout. It adds no logic of its own: every
method delegates to the harness.

Protocol (newline-delimited JSON, both directions)
    in : {"id": <n>, "method": "<name>", "params": {...}}
    out: {"id": <n>, "event": "<type>", "data": {...}}   (0+ per request)
         {"id": <n>, "done": true[, "data": {...}]}       (terminates a request)
         {"id": <n>, "error": "<message>"}                (terminates, fatal)

Control messages (target an in-flight streaming request, no reply):
    {"method": "chat.permission", "params": {"request_id": <m>, "allow": bool,
                                             "remember": "session"|"project" (optional),
                                             "permission_id": <k> (optional),
                                             "message": "<what to do instead>" (optional,
                                             only read when allow is false)}}
    A `permission_request` event carries "permission_id"; an answer that
    echoes a different id (a late answer to an earlier prompt) is dropped.
    {"method": "chat.cancel",     "params": {"request_id": <m>}}

Coding sessions (one per bridge process, started by code.start or
code.resume; every other code.* method needs one):
    code.start {cwd, model, backend?, stream_model?, mode?, context_length?, mcp?, knowledge?}
    code.resume {cwd, session_id}      code.sessions {cwd}
    code.mode {mode}                   code.todos        code.rules.list
    code.rules.add / code.rules.remove {tool, pattern?, scope}
    code.undo {confirm?, force?}       (streaming:) code.turn {text, images?}, code.compact

Also answered: ping, and config.get, models.installed and cloud.models, which
AIhub's own bridge handlers serve (read from the same ~/.aihub).

Each request runs on its own daemon thread; a single lock serialises writes to
the protocol channel. Run as `python -m aihub_code.bridge` or via the
`aihub-code-bridge` console script.
"""
from __future__ import annotations

import contextlib
import itertools
import json
import logging
import os
import queue
import signal
import sys
import threading
from typing import Any, Callable, Dict

from . import __version__
from .backends import resolve_stream_fn as _resolve_stream_fn

log = logging.getLogger(__name__)

# ── Protocol channel ──────────────────────────────────────────────────────────
# Capture the real stdout for the JSON protocol, then redirect sys.stdout to
# stderr so any stray library print() can never corrupt the byte stream.
# The protocol is UTF-8 everywhere (Windows pipes default to the ANSI code page).
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
_OUT = sys.stdout
sys.stdout = sys.stderr

_write_lock = threading.Lock()


def _detach_std_fds():
    """Keep the protocol on private copies of fds 0 and 1, and give the real
    fds 0 and 1 /dev/null and stderr. Every child the engine starts (a
    browser via webbrowser, xdg-open, …) inherits fds 0 and 1: a console
    browser would read the requests and draw into the replies, and a GUI
    one prints into them. Returns the request stream."""
    global _OUT
    in_fd, out_fd = os.dup(0), os.dup(1)
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.close(null)
    os.dup2(2, 1)
    _OUT = os.fdopen(out_fd, "w", encoding="utf-8", errors="replace")
    return os.fdopen(in_fd, "r", encoding="utf-8", errors="replace")


def _send(obj: Dict[str, Any]) -> None:
    with _write_lock:
        _OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
        _OUT.flush()


def _emit(req_id: Any, event: str, data: Dict[str, Any] | None = None) -> None:
    _send({"id": req_id, "event": event, "data": data or {}})


def _done(req_id: Any, data: Dict[str, Any] | None = None) -> None:
    msg: Dict[str, Any] = {"id": req_id, "done": True}
    if data is not None:
        msg["data"] = data
    _send(msg)


def _error(req_id: Any, message: Any) -> None:
    _send({"id": req_id, "error": str(message)})


# ── In-flight streaming request registries ────────────────────────────────────
_reg_lock = threading.Lock()
_cancel_events: Dict[Any, threading.Event] = {}
_perm_queues: Dict[Any, "queue.Queue[bool]"] = {}
_perm_ids: Dict[Any, int] = {}      # request id -> the prompt now waiting for an answer
_perm_counter = itertools.count(1)
_MAX_DENIAL_MESSAGE = 2000     # characters of a denial's "do this instead"



# ── Coding sessions (code.*) ──────────────────────────────────────────────────

class _CodeError(Exception):
    """A code.* failure whose message goes to the front-end as it is."""


_code = None            # the process's CodeSession, guarded by _reg_lock
_code_busy = False      # a turn / compaction / undo is running on it
NO_CODE_SESSION = "no code session \u2014 call code.start first"
BUSY_TURN = "a turn is running"
BUSY_PROJECT = "Another aihub-code session is working in this project."


def _code_session():
    with _reg_lock:
        if _code is None:
            raise _CodeError(NO_CODE_SESSION)
        return _code


@contextlib.contextmanager
def _claim_code():
    """Mark the code session busy (turn, compaction, undo, start, mode change)
    so no other call changes it meanwhile; "a turn is running" if it is."""
    global _code_busy
    with _reg_lock:
        if _code_busy:
            raise _CodeError(BUSY_TURN)
        _code_busy = True
    try:
        yield
    finally:
        with _reg_lock:
            _code_busy = False


@contextlib.contextmanager
def _code_work():
    """Exclusive use of the code session for work that changes the project or
    the history: this process's busy flag plus the project's session lock.
    Yields the session, read once."""
    from .engine.filelock import LockBusy, try_file_lock
    from .project import store_dir
    with _claim_code():
        s = _code_session()
        try:
            with try_file_lock(os.path.join(store_dir(s.project.root), "session.lock")):
                yield s
        except LockBusy:
            raise _CodeError(BUSY_PROJECT) from None


def _rule_dict(r) -> Dict[str, Any]:
    return {"tool": r.tool, "pattern": r.pattern, "scope": r.scope}


def _code_info(s) -> Dict[str, Any]:
    pr = s.project
    return {
        "session_id": s.id,
        "project": {"root": pr.root, "branch": pr.branch, "dirty_total": pr.dirty_total,
                    "instruction_file": pr.instruction_file, "is_git": pr.is_git},
        "mode": s.mode, "model": s.model,
        "rules": [_rule_dict(r) for r in s.rules.all()],
        "context_length": s.context_length,
        "checkpoints": {"mode": s.checkpoints.mode, "note": s.checkpoints.note},
    }


def _install_code(make):
    """Build a session and make it the process's; returns (info, session).
    The busy flag is held throughout (the session dir is process-global)."""
    global _code
    with _claim_code():
        try:
            s = make()
        except (ValueError, FileNotFoundError) as exc:
            raise _CodeError(str(exc)) from None
        with _reg_lock:
            _code = s
    return _code_info(s), s


def _code_cwd(p) -> str:
    cwd = p.get("cwd")
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        raise _CodeError(f"no such folder: {cwd}")
    return cwd


def _h_code_start(p):
    from .session import CodeSession
    cwd = _code_cwd(p)
    return _install_code(lambda: CodeSession.start(
        cwd, p["model"], backend=p.get("backend") or "ollama",
        mode=p.get("mode") or "build", stream_model=p.get("stream_model") or None,
        context_length=p.get("context_length") or None,
        mcp=p.get("mcp"), knowledge=p.get("knowledge")))[0]


def _h_code_resume(p):
    from .session import CodeSession
    cwd = _code_cwd(p)
    info, s = _install_code(lambda: CodeSession.resume(cwd, p["session_id"]))
    info["messages"] = s.messages
    return info


def _h_code_sessions(p):
    from .project import find_root, store_dir
    from .session import SessionStore
    if p.get("cwd") is not None:
        root, _ = find_root(_code_cwd(p))
    else:
        root = _code_session().project.root
    store = store_dir(root, create=False)
    if not os.path.isdir(store):
        return {"sessions": []}         # never worked on here: create nothing
    return {"sessions": SessionStore(store).list()}


def _h_code_mode(p):
    s = _code_session()
    with _claim_code():
        try:
            s.set_mode(p["mode"])
        except ValueError as exc:
            raise _CodeError(str(exc)) from None
    return {"mode": s.mode}


def _h_code_todos(p):
    return {"todos": _code_session().todo.to_list()}


def _h_code_rules_list(p):
    return {"rules": [_rule_dict(r) for r in _code_session().rules.all()]}


def _code_rule(p, method):
    from .permissions import Rule
    if not isinstance(p.get("tool"), str) or not p["tool"]:
        raise _CodeError(f"{method} needs 'tool'")
    scope = p.get("scope") or "session"
    if scope not in ("session", "project"):
        raise _CodeError(f"unknown scope {scope!r}")
    return Rule(p["tool"], p.get("pattern"), scope)


def _h_code_rules_add(p):
    s = _code_session()
    s.rules.add(_code_rule(p, "code.rules.add"))
    return {"rules": [_rule_dict(r) for r in s.rules.all()]}


def _h_code_rules_remove(p):
    s = _code_session()
    s.rules.remove(_code_rule(p, "code.rules.remove"))
    return {"rules": [_rule_dict(r) for r in s.rules.all()]}


def _plan_dict(plan, applied: bool) -> Dict[str, Any]:
    return {"turn_id": plan.turn_id, "restore": plan.restore, "delete": plan.delete,
            "conflicts": plan.conflicts, "shell_not_reverted": plan.shell_not_reverted,
            "skipped": plan.skipped, "mode": plan.mode, "applied": applied}


def _h_code_undo(p):
    from .checkpoints import CheckpointError, NothingToUndo, UndoConflict
    confirm = p.get("confirm") is True
    try:
        # A preview takes a snapshot too: it needs the project to itself.
        with _code_work() as s:
            if confirm:
                return _plan_dict(s.undo(confirm=True, force=p.get("force") is True), True)
            return _plan_dict(s.undo(confirm=False), False)
    except UndoConflict as exc:
        return _plan_dict(exc.plan, False)
    except NothingToUndo:
        raise _CodeError("nothing to undo") from None
    except CheckpointError as exc:
        raise _CodeError(str(exc)) from None


def _stream_code_turn(req_id, p) -> None:
    from .session import run_turn
    with _code_work() as s, _turn_registry(req_id) as (cancel, ask):
        stream_fn = _resolve_stream_fn(s.stream_model, s.backend)
        o = run_turn(s, p["text"], emit=lambda e, d=None: _emit(req_id, e, d), ask=ask,
                     cancel=cancel, stream_fn=stream_fn, images=p.get("images") or None)
    _done(req_id, {"messages": o.messages, "cancelled": o.cancelled})


def _stream_code_compact(req_id, p) -> None:
    cancel = threading.Event()
    with _reg_lock:
        _cancel_events[req_id] = cancel
    try:
        with _code_work() as s:
            stream_fn = _resolve_stream_fn(s.stream_model, s.backend)
            result = s.compact(stream_fn, cancel.is_set)
    finally:
        with _reg_lock:
            _cancel_events.pop(req_id, None)
    _emit(req_id, "code_compaction", result.to_dict())
    _done(req_id, {"result": result.to_dict()})



_aihub_mod = None
_aihub_lock = threading.Lock()

# AIhub methods aihub-code does not serve: the project folder is the working
# directory, so a front-end has no use for changing the engine's.
_DENY = {"workdir.set": "workdir.set: not available in aihub-code (start it in the folder you want)"}

_delegated: set = set()     # request ids of the running delegated (AIhub) streams


def _aihub():
    """AIhub's own bridge module, imported on first use: importing it takes
    over sys.stdout. Its _emit/_done/_error look `_send` up as a module global
    at call time, so pointing it at ours puts its events on our protocol
    channel. Re-pointed on every call: cheap, and always the current one."""
    global _aihub_mod
    with _aihub_lock:
        first = _aihub_mod is None
        if first:
            from aihub import bridge as mod
            _aihub_mod = mod
        _aihub_mod._send = _send
        if first:
            # AIhub's tools run in the folder aihub-code was started in (a
            # code session, if one is already up, has set its project root).
            from aihub.tools import workdir
            if not workdir._session_dir:
                try:
                    workdir.set_session_dir(os.getcwd())
                except OSError:
                    log.warning("could not set the working directory", exc_info=True)
        return _aihub_mod


def _handlers() -> set:
    """Every method this bridge answers."""
    mod = _aihub()
    return set(_ONESHOT) | set(_STREAMING) | ((set(mod._ONESHOT) | set(mod._STREAMING)) - set(_DENY))


def _h_code_options(p):
    """MCP servers and knowledge bases for this session, from the next turn."""
    kb = p.get("knowledge")
    if kb is not None and (not isinstance(kb, list) or not all(isinstance(x, str) for x in kb)):
        raise _CodeError("knowledge must be a list of names")
    mcp = p.get("mcp")
    with _claim_code():
        s = _code_session()
        return s.set_options(mcp if isinstance(mcp, bool) else None, kb)


def _h_ping(p):
    return {"version": __version__}


_ONESHOT: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "ping": _h_ping,
    "code.start": _h_code_start,
    "code.resume": _h_code_resume,
    "code.sessions": _h_code_sessions,
    "code.mode": _h_code_mode,
    "code.undo": _h_code_undo,
    "code.todos": _h_code_todos,
    "code.rules.list": _h_code_rules_list,
    "code.rules.add": _h_code_rules_add,
    "code.rules.remove": _h_code_rules_remove,
    "code.options": _h_code_options,
}


_STREAMING: Dict[str, Callable[[Any, Dict[str, Any]], None]] = {
    "code.turn": _stream_code_turn,
    "code.compact": _stream_code_compact,
}


# ── Streaming turns: cancel and permission registries ─────────────────────────

@contextlib.contextmanager
def _turn_registry(req_id):
    """Register a streaming turn for chat.cancel / chat.permission and yield
    (cancel event, ask)."""
    cancel = threading.Event()
    pq: "queue.Queue[Any]" = queue.Queue()
    with _reg_lock:
        _cancel_events[req_id] = cancel
        _perm_queues[req_id] = pq

    def ask(payload):
        with _reg_lock:
            pid = next(_perm_counter)
            _perm_ids[req_id] = pid
        _emit(req_id, "permission_request", {**payload, "permission_id": pid})
        try:
            item = pq.get()
        finally:
            with _reg_lock:
                if _perm_ids.get(req_id) == pid:
                    del _perm_ids[req_id]
        if isinstance(item, tuple):
            out = (bool(item[0]), item[1] if len(item) > 1 else None)
            return out + (item[2],) if len(item) > 2 else out
        return bool(item), None

    try:
        yield cancel, ask
    finally:
        with _reg_lock:
            _cancel_events.pop(req_id, None)
            _perm_queues.pop(req_id, None)
            _perm_ids.pop(req_id, None)


# ── Dispatch ──────────────────────────────────────────────────────────────────

def _run_delegated(req_id, method, params) -> bool:
    """Serve `method` from AIhub's engine; False when it has no such method."""
    if method in _DENY:
        raise _CodeError(_DENY[method])
    mod = _aihub()
    if method in mod._STREAMING:
        with _reg_lock:
            _delegated.add(req_id)
        try:
            mod._STREAMING[method](req_id, params)
        finally:
            with _reg_lock:
                _delegated.discard(req_id)
        return True
    if method in mod._ONESHOT:
        _done(req_id, mod._ONESHOT[method](params))
        return True
    return False


def _run(req_id, method, params) -> None:
    try:
        if method in _STREAMING:
            _STREAMING[method](req_id, params)
        elif method in _ONESHOT:
            _done(req_id, _ONESHOT[method](params))
        elif not _run_delegated(req_id, method, params):
            _error(req_id, f"unknown method: {method}")
    except _CodeError as exc:
        _error(req_id, str(exc))
    except Exception as exc:  # never let a worker crash take down the bridge
        _error(req_id, f"{method}: {exc}")


def _control_delegated(method, params) -> None:
    """chat.cancel / chat.permission for an AIhub stream: the same puts and
    sets as AIhub's own _dispatch (v1.5.0)."""
    mod = _aihub()
    rid = params.get("request_id")
    with mod._reg_lock:
        ev = mod._cancel_events.get(rid)
        q = mod._perm_queues.get(rid)
    if method == "chat.permission":
        if q is not None:
            q.put(params.get("allow") is True)      # only a JSON true is consent
        return
    if ev is not None:
        ev.set()
    if q is not None:   # unblock a pending permission wait as a denial
        q.put(False)


def _cancel_delegated() -> None:
    """Shutdown: stop the AIhub streams still running."""
    if _aihub_mod is None:
        return
    with _reg_lock:
        ids = list(_delegated)
    with _aihub_mod._reg_lock:
        events = [_aihub_mod._cancel_events.get(i) for i in ids]
    for ev in events:
        if ev is not None:
            ev.set()


def _dispatch(line: str) -> None:
    try:
        msg = json.loads(line)
    except Exception:
        log.warning("ignoring malformed request line: %.200s", line)
        return
    method = msg.get("method")
    params = msg.get("params") or {}

    # Control messages target an in-flight streaming request.
    if method in ("chat.permission", "chat.cancel"):
        with _reg_lock:
            theirs = params.get("request_id") in _delegated
        if theirs:
            _control_delegated(method, params)
            return
    if method == "chat.permission":
        rid = params.get("request_id")
        with _reg_lock:
            q = _perm_queues.get(rid)
            pending = _perm_ids.get(rid)
            if "permission_id" in params and (pending is None or params["permission_id"] != pending):
                q = None        # an answer to another prompt, or a repeat
            elif q is not None:
                _perm_ids.pop(rid, None)    # answered: a repeat can't answer the next one
        if q is not None:
            allow = params.get("allow") is True      # only a JSON true is consent
            remember = params.get("remember")
            message = params.get("message")     # user text: why not, or what to do instead
            message = message.strip()[:_MAX_DENIAL_MESSAGE] if isinstance(message, str) else ""
            if allow or not message:
                q.put((allow, remember) if isinstance(remember, str) else allow)
            else:
                q.put((False, remember if isinstance(remember, str) else None, message))
        return
    if method == "chat.cancel":
        rid = params.get("request_id")
        with _reg_lock:
            ev = _cancel_events.get(rid)
            q = _perm_queues.get(rid)
        if ev is not None:
            ev.set()
        if q is not None:   # unblock a pending permission wait as a denial
            q.put(False)
        return

    threading.Thread(target=_run, args=(msg.get("id"), method, params),
                     daemon=True).start()


def _kill_code_shells() -> None:
    shell = sys.modules.get("aihub_code.shell")   # never imported: nothing runs
    if shell is not None:
        shell.kill_all()


# Set once main() starts cleaning up: a signal then must not cut the cleanup short.
_closing = False


def _exit_on_signal(signum, frame) -> None:
    if not _closing:
        raise SystemExit(128 + signum)


def _install_signal_exit() -> None:
    """SIGTERM/SIGHUP (the app quitting, a terminal hangup) end main() through
    its finally: Python's default action skips it, and the commands the agent
    started (in their own sessions) and the MCP servers would outlive us."""
    for name in ("SIGTERM", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, _exit_on_signal)
        except (ValueError, OSError):   # not the main thread
            pass


def main() -> None:
    """Read NDJSON requests from stdin until EOF (or SIGTERM/SIGHUP)."""
    global _closing
    _closing = False
    # stdout is the protocol channel; logs go to stderr (the front-end keeps it).
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    for name in ("aihub", "aihub_code"):
        root = logging.getLogger(name)
        root.addHandler(handler)
        root.setLevel(logging.INFO)
    _install_signal_exit()
    requests_in = _detach_std_fds()
    _emit(None, "ready", {"version": __version__})
    try:
        for line in requests_in:
            line = line.strip()
            if line:
                _dispatch(line)
    finally:
        _closing = True
        _kill_code_shells()              # running aihub-code commands too
        _cancel_delegated()              # and AIhub's downloads, indexing, chats
        from aihub.mcp_client import shutdown
        shutdown()                       # MCP server subprocesses go with us


if __name__ == "__main__":
    main()
