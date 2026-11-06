import os
import shutil
import subprocess

import pytest

from aihub_code import checkpoints
from aihub_code.checkpoints import CheckpointStore, NothingToUndo, UndoConflict

needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git missing")


@pytest.fixture
def proj(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    return root


def _store(tmp_path, root, **kw):
    return CheckpointStore(str(root), str(tmp_path / "store"), **kw)


def _git(root, *args):
    return subprocess.run(
        ["git", "--no-optional-locks", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@t", *args],
        check=True, capture_output=True,
    ).stdout


def _tree_state(path):
    out = {}
    for dirpath, _dirs, files in os.walk(path):
        for name in files:
            full = os.path.join(dirpath, name)
            st = os.stat(full)
            with open(full, "rb") as fh:
                out[os.path.relpath(full, path)] = (st.st_mtime_ns, fh.read())
    return out


@needs_git
def test_undo_reverts_edit_and_shell_changes(tmp_path, proj):
    (proj / "a.txt").write_bytes(b"alpha\n")
    (proj / "b.txt").write_bytes(b"beta\n")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    assert cp.mode == "shadow" and cp.note == ""
    (proj / "a.txt").write_bytes(b"changed\n")
    (proj / "new.txt").write_bytes(b"new\n")
    (proj / "b.txt").unlink()
    cp.finish_turn()
    plan = cp.undo_plan()
    assert plan.turn_id == "t1" and plan.mode == "shadow"
    assert {"a.txt", "b.txt"} <= set(plan.restore)
    assert plan.delete == ["new.txt"]
    assert plan.conflicts == [] and plan.shell_not_reverted == []
    cp.undo()
    assert (proj / "a.txt").read_bytes() == b"alpha\n"
    assert (proj / "b.txt").read_bytes() == b"beta\n"
    assert not (proj / "new.txt").exists()
    # Nothing of the shadow repo lands in the project.
    assert sorted(os.listdir(proj)) == ["a.txt", "b.txt"]


@needs_git
def test_gitignored_files_untouched(tmp_path, proj):
    (proj / ".gitignore").write_text("out/\n")
    (proj / "out").mkdir()
    (proj / "out" / "old.bin").write_bytes(b"old")
    (proj / "a.txt").write_text("a")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    (proj / "out" / "made.bin").write_bytes(b"made during turn")
    (proj / "out" / "old.bin").write_bytes(b"rebuilt")
    (proj / "a.txt").write_text("b")
    cp.finish_turn()
    plan = cp.undo_plan()
    assert not any(p.startswith("out/") for p in plan.restore + plan.delete)
    cp.undo()
    assert (proj / "a.txt").read_text() == "a"
    assert (proj / "out" / "made.bin").read_bytes() == b"made during turn"
    assert (proj / "out" / "old.bin").read_bytes() == b"rebuilt"


@needs_git
def test_file_ignored_later_is_left_alone(tmp_path, proj):
    (proj / "log.txt").write_text("v0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")  # log.txt is in this snapshot
    cp.finish_turn()
    (proj / ".gitignore").write_text("log.txt\n")
    cp.begin_turn("t2")
    (proj / "log.txt").write_text("v1")
    cp.finish_turn()
    plan = cp.undo_plan()
    assert "log.txt" not in plan.restore + plan.delete
    cp.undo()
    assert (proj / "log.txt").read_text() == "v1"


@needs_git
def test_node_modules_excluded_without_gitignore(tmp_path, proj):
    (proj / "a.txt").write_text("a")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    (proj / "node_modules").mkdir()
    (proj / "node_modules" / "x.js").write_text("x")
    (proj / ".venv").mkdir()
    (proj / ".venv" / "pyvenv.cfg").write_text("v")
    (proj / "a.txt").write_text("b")
    cp.finish_turn()
    plan = cp.undo_plan()
    assert plan.restore == ["a.txt"] and plan.delete == []
    cp.undo()
    assert (proj / "node_modules" / "x.js").read_text() == "x"
    assert (proj / ".venv" / "pyvenv.cfg").read_text() == "v"


@needs_git
def test_users_git_untouched(tmp_path, proj):
    _git(proj, "init", "-q")
    (proj / "a.txt").write_text("committed\n")
    (proj / "staged.txt").write_text("s\n")
    _git(proj, "add", "a.txt")
    _git(proj, "commit", "-q", "-m", "init")
    _git(proj, "add", "staged.txt")
    (proj / "a.txt").write_text("dirty\n")
    (proj / "untracked.txt").write_text("u\n")
    git_before = _tree_state(proj / ".git")
    status_before = _git(proj, "status", "--porcelain")
    head_before = _git(proj, "rev-parse", "HEAD")

    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    (proj / "a.txt").write_text("turn edit\n")
    (proj / "new.txt").write_text("n\n")
    cp.finish_turn()
    plan = cp.undo_plan()
    assert not any(p == ".git" or p.startswith(".git/") for p in plan.restore + plan.delete)
    cp.undo()

    assert _tree_state(proj / ".git") == git_before
    assert _git(proj, "status", "--porcelain") == status_before
    assert _git(proj, "rev-parse", "HEAD") == head_before
    assert (proj / "a.txt").read_text() == "dirty\n"


@needs_git
def test_nested_repos_left_alone(tmp_path, proj):
    (proj / "a.txt").write_text("a")
    full = proj / "vendor" / "lib"
    full.mkdir(parents=True)
    _git(full, "init", "-q")
    (full / "f.txt").write_text("lib v1")
    _git(full, "add", "f.txt")
    _git(full, "commit", "-q", "-m", "i")
    _git(proj, "init", "-q", "empty")  # a repo without any commit
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    assert cp.mode == "shadow", cp.note
    (full / "f.txt").write_text("lib v2")
    _git(proj, "init", "-q", "cloned")
    (proj / "cloned" / "c.txt").write_text("c")
    (proj / "a.txt").write_text("b")
    cp.finish_turn()
    assert cp.mode == "shadow", cp.note
    plan = cp.undo_plan()
    assert plan.restore == ["a.txt"] and plan.delete == []
    cp.undo()
    assert (proj / "a.txt").read_text() == "a"
    assert (full / "f.txt").read_text() == "lib v2"
    assert (proj / "cloned" / "c.txt").read_text() == "c"
    assert (proj / "cloned" / ".git" / "HEAD").exists()
    assert _git(full, "log", "--oneline").count(b"\n") == 1


@needs_git
def test_external_change_conflicts(tmp_path, proj):
    (proj / "a.txt").write_text("a0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    (proj / "a.txt").write_text("a1")
    cp.finish_turn()
    (proj / "a.txt").write_text("a2 by the user")
    with pytest.raises(UndoConflict) as err:
        cp.undo()
    assert err.value.plan.conflicts == ["a.txt"]
    assert (proj / "a.txt").read_text() == "a2 by the user"
    plan = cp.undo(force=True)
    assert plan.conflicts == ["a.txt"]
    assert (proj / "a.txt").read_text() == "a0"


@needs_git
def test_two_undos_walk_back(tmp_path, proj):
    (proj / "a.txt").write_text("0")
    cp = _store(tmp_path, proj)
    for turn, text in (("t1", "1"), ("t2", "2")):
        cp.begin_turn(turn)
        cp.note_shell("(the turn ran a command)")
        (proj / "a.txt").write_text(text)
        cp.finish_turn()
    assert cp.undo().turn_id == "t2"
    assert (proj / "a.txt").read_text() == "1"
    assert cp.undo().turn_id == "t1"
    assert (proj / "a.txt").read_text() == "0"
    with pytest.raises(NothingToUndo):
        cp.undo_plan()


def test_nothing_to_undo(tmp_path, proj):
    cp = _store(tmp_path, proj)
    with pytest.raises(NothingToUndo):
        cp.undo_plan()
    with pytest.raises(NothingToUndo):
        cp.undo()


@needs_git
def test_crlf_and_latin1_bytes_restored(tmp_path, proj):
    # A .gitattributes asking for conversion must not change the bytes.
    (proj / ".gitattributes").write_text("* text eol=crlf\n*.txt ident\n")
    crlf = b"one\r\ntwo\r\n"
    lf = b"plain\nlf $Id$\n"
    latin1 = "zażółć café\n".encode("latin-1", errors="replace") + b"\xe9\xff\n"
    binary = bytes(range(256)) * 4
    files = {"crlf.txt": crlf, "lf.txt": lf, "latin1.txt": latin1, "blob.bin": binary}
    for name, data in files.items():
        (proj / name).write_bytes(data)
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    for name in files:
        (proj / name).write_bytes(b"overwritten\n")
    cp.finish_turn()
    cp.undo()
    for name, data in files.items():
        assert (proj / name).read_bytes() == data, name


def test_fallback_when_git_missing(tmp_path, proj, monkeypatch):
    monkeypatch.setattr(checkpoints.shutil, "which", lambda *_a, **_k: None)
    (proj / "a.txt").write_bytes(b"a\r\n")
    cp = _store(tmp_path, proj)
    assert cp.mode == "files" and "git" in cp.note
    cp.begin_turn("t1")
    cp.record_before("a.txt")
    (proj / "a.txt").write_bytes(b"changed")
    cp.record_before(str(proj / "a.txt"))  # second call keeps the first copy
    (proj / "a.txt").write_bytes(b"changed again")
    cp.record_before("sub/new.txt")
    (proj / "sub").mkdir()
    (proj / "sub" / "new.txt").write_text("n")
    cp.note_shell("touch x")
    (proj / "x").write_text("")
    cp.finish_turn()
    plan = cp.undo_plan()
    assert plan.mode == "files"
    assert plan.restore == ["a.txt"] and plan.delete == ["sub/new.txt"]
    assert plan.shell_not_reverted == ["touch x"] and plan.conflicts == []
    cp.undo()
    assert (proj / "a.txt").read_bytes() == b"a\r\n"
    assert not (proj / "sub" / "new.txt").exists()
    assert (proj / "x").exists()  # shell effects are not reverted
    with pytest.raises(NothingToUndo):
        cp.undo_plan()


def test_files_mode_conflict(tmp_path, proj, monkeypatch):
    monkeypatch.setattr(checkpoints.shutil, "which", lambda *_a, **_k: None)
    (proj / "a.txt").write_text("a0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.record_before("a.txt")
    (proj / "a.txt").write_text("a1")
    cp.finish_turn()
    (proj / "a.txt").write_text("a2")
    with pytest.raises(UndoConflict) as err:
        cp.undo()
    assert err.value.plan.conflicts == ["a.txt"]
    cp.undo(force=True)
    assert (proj / "a.txt").read_text() == "a0"


@needs_git
def test_fallback_when_too_many_files(tmp_path, proj):
    for i in range(10):
        (proj / f"f{i}.txt").write_text(str(i))
    cp = _store(tmp_path, proj, max_files=5)
    cp.begin_turn("t1")
    assert cp.mode == "files" and "5" in cp.note and "files" in cp.note
    cp.record_before("f0.txt")
    (proj / "f0.txt").write_text("x")
    cp.finish_turn()
    cp.undo()
    assert (proj / "f0.txt").read_text() == "0"


@needs_git
def test_fallback_when_snapshot_times_out(tmp_path, proj, monkeypatch):
    (proj / "a.txt").write_text("a")
    cp = _store(tmp_path, proj)
    real_run = checkpoints.subprocess.run

    def slow_add(args, **kw):
        if "add" in args:
            raise subprocess.TimeoutExpired(args, kw.get("timeout"))
        return real_run(args, **kw)

    monkeypatch.setattr(checkpoints.subprocess, "run", slow_add)
    cp.begin_turn("t1")  # never raises
    assert cp.mode == "files" and "3" in cp.note
    cp.record_before("a.txt")
    (proj / "a.txt").write_text("b")
    cp.finish_turn()
    cp.undo()
    assert (proj / "a.txt").read_text() == "a"


@needs_git
def test_git_error_falls_back(tmp_path, proj):
    (proj / "a.txt").write_text("a")
    store = tmp_path / "store"
    store.mkdir()
    (store / "shadow.git").write_text("not a repository")  # git init fails
    cp = CheckpointStore(str(proj), str(store))
    cp.begin_turn("t1")
    assert cp.mode == "files" and cp.note


@needs_git
def test_prune_keeps_last_n(tmp_path, proj):
    (proj / "a.txt").write_text("0")
    cp = _store(tmp_path, proj, keep=2)
    for i in (1, 2, 3):
        cp.begin_turn(f"t{i}")
        cp.note_shell("(the turn ran a command)")
        (proj / "a.txt").write_text(str(i))
        cp.finish_turn()
    assert cp.undo().turn_id == "t3"
    assert cp.undo().turn_id == "t2"
    with pytest.raises(NothingToUndo):
        cp.undo_plan()
    assert (proj / "a.txt").read_text() == "1"
    refs = subprocess.run(
        ["git", f"--git-dir={tmp_path / 'store' / 'shadow.git'}", "for-each-ref", "--format=%(refname)"],
        capture_output=True, check=True, text=True,
    ).stdout
    assert "refs/aihub/t1/" not in refs and "refs/aihub/t3/" in refs


@needs_git
def test_state_survives_a_new_session(tmp_path, proj):
    (proj / "a.txt").write_text("0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    (proj / "a.txt").write_text("1")
    cp.finish_turn()
    again = _store(tmp_path, proj)
    assert again.undo().turn_id == "t1"
    assert (proj / "a.txt").read_text() == "0"


def _fail_add(monkeypatch):
    real_run = checkpoints.subprocess.run

    def run(args, **kw):
        if "add" in args:
            raise subprocess.TimeoutExpired(args, kw.get("timeout"))
        return real_run(args, **kw)

    monkeypatch.setattr(checkpoints.subprocess, "run", run)


@needs_git
def test_undo_is_turn_scoped(tmp_path, proj):
    (proj / "a.txt").write_text("a0")
    (proj / "c.txt").write_text("c0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    (proj / "a.txt").write_text("a1")
    cp.finish_turn()
    (proj / "c.txt").write_text("c by the user")
    (proj / "mine.txt").write_text("user work")
    plan = cp.undo()
    assert plan.restore == ["a.txt"] and plan.delete == [] and plan.conflicts == []
    assert (proj / "a.txt").read_text() == "a0"
    assert (proj / "c.txt").read_text() == "c by the user"
    assert (proj / "mine.txt").read_text() == "user work"


@needs_git
def test_finish_failure_makes_later_work_a_conflict(tmp_path, proj, monkeypatch):
    (proj / "a.txt").write_text("a0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    (proj / "a.txt").write_text("a1")
    with monkeypatch.context() as m:
        _fail_add(m)
        cp.finish_turn()  # the end snapshot is lost
    (proj / "user.txt").write_text("user work")
    with pytest.raises(UndoConflict) as err:
        cp.undo()
    assert {"a.txt", "user.txt"} <= set(err.value.plan.conflicts)
    assert (proj / "user.txt").exists()
    cp.undo(force=True)
    assert (proj / "a.txt").read_text() == "a0"


@needs_git
def test_crash_without_finish_makes_later_work_a_conflict(tmp_path, proj):
    (proj / "a.txt").write_text("a0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    (proj / "a.txt").write_text("a1")
    again = _store(tmp_path, proj)  # AIhub crashed before finish_turn
    (proj / "user.txt").write_text("user work")
    with pytest.raises(UndoConflict) as err:
        again.undo()
    assert {"a.txt", "user.txt"} <= set(err.value.plan.conflicts)
    again.undo(force=True)
    assert (proj / "a.txt").read_text() == "a0"


def test_files_mode_crash_without_finish_is_a_conflict(tmp_path, proj, monkeypatch):
    monkeypatch.setattr(checkpoints.shutil, "which", lambda *_a, **_k: None)
    (proj / "a.txt").write_text("a0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.record_before("a.txt")
    (proj / "a.txt").write_text("a1")
    again = _store(tmp_path, proj)
    with pytest.raises(UndoConflict) as err:
        again.undo()
    assert err.value.plan.conflicts == ["a.txt"]
    again.undo(force=True)
    assert (proj / "a.txt").read_text() == "a0"


@needs_git
def test_file_replaced_by_directory_is_restored(tmp_path, proj):
    (proj / "x").write_bytes(b"file x\n")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    (proj / "x").unlink()
    (proj / "x" / "sub").mkdir(parents=True)
    (proj / "x" / "sub" / "y").write_text("y")
    cp.finish_turn()
    plan = cp.undo_plan()
    assert plan.restore == ["x"] and plan.delete == ["x/sub/y"] and plan.skipped == []
    cp.undo()
    assert (proj / "x").read_bytes() == b"file x\n"


@needs_git
def test_directory_replaced_by_symlink_is_restored(tmp_path, proj):
    outside = tmp_path / "outside"
    outside.mkdir()
    (proj / "dir").mkdir()
    (proj / "dir" / "f.txt").write_bytes(b"precious\n")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    shutil.rmtree(proj / "dir")
    os.symlink(outside, proj / "dir")
    cp.finish_turn()
    plan = cp.undo_plan()
    assert plan.restore == ["dir/f.txt"] and plan.delete == ["dir"] and plan.skipped == []
    cp.undo()
    assert not (proj / "dir").is_symlink()
    assert (proj / "dir" / "f.txt").read_bytes() == b"precious\n"
    assert os.listdir(outside) == []


@needs_git
def test_unsafe_restore_is_skipped_not_dropped(tmp_path, proj):
    (proj / ".gitignore").write_text("*.log\n")
    (proj / "x").write_text("file x")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    (proj / "x").unlink()
    (proj / "x").mkdir()
    (proj / "x" / "y").write_text("y")
    (proj / "x" / "keep.log").write_text("ignored, not ours")
    cp.finish_turn()
    plan = cp.undo_plan()
    assert plan.skipped == ["x"] and plan.delete == ["x/y"]
    done = cp.undo()
    assert done.skipped == ["x"]
    assert (proj / "x" / "keep.log").read_text() == "ignored, not ours"


def test_files_mode_never_writes_through_a_symlink(tmp_path, proj, monkeypatch):
    monkeypatch.setattr(checkpoints.shutil, "which", lambda *_a, **_k: None)
    outside = tmp_path / "authorized_keys"
    outside.write_bytes(b"SECRET KEYS\n")
    (proj / "a.txt").write_bytes(b"a0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.record_before("a.txt")
    (proj / "a.txt").write_bytes(b"a1")
    (proj / "a.txt").unlink()
    os.symlink(outside, proj / "a.txt")  # a shell `ln -sf`
    cp.finish_turn()
    cp.undo()
    assert outside.read_bytes() == b"SECRET KEYS\n"
    assert not (proj / "a.txt").is_symlink()
    assert (proj / "a.txt").read_bytes() == b"a0"


def test_files_mode_restores_a_symlink_as_a_link(tmp_path, proj, monkeypatch):
    monkeypatch.setattr(checkpoints.shutil, "which", lambda *_a, **_k: None)
    target = tmp_path / "target.txt"
    target.write_bytes(b"target")
    os.symlink(target, proj / "link")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.record_before("link")
    (proj / "link").unlink()
    (proj / "link").write_bytes(b"now a file")
    cp.finish_turn()
    cp.undo()
    from aihub_code.checkpoints import _readlink
    assert (proj / "link").is_symlink()
    assert _readlink(str(proj / "link")) == str(target)   # Windows' readlink adds "\\?\"
    assert target.read_bytes() == b"target"


def test_failed_copy_is_reported_as_skipped(tmp_path, proj, monkeypatch):
    monkeypatch.setattr(checkpoints.shutil, "which", lambda *_a, **_k: None)
    (proj / "a.txt").write_text("a0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")

    def broken_copy(*_a, **_k):
        raise OSError("disk full")

    with monkeypatch.context() as m:
        m.setattr(checkpoints.shutil, "copyfile", broken_copy)
        cp.record_before("a.txt")
    (proj / "a.txt").write_text("a1")
    cp.finish_turn()
    plan = cp.undo()
    assert plan.skipped == ["a.txt"] and plan.restore == []
    assert (proj / "a.txt").read_text() == "a1"


@needs_git
def test_users_info_exclude_respected(tmp_path, proj):
    _git(proj, "init", "-q")
    (proj / ".git" / "info").mkdir(exist_ok=True)
    (proj / ".git" / "info" / "exclude").write_text("secret.env\n")
    (proj / "a.txt").write_text("a0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    (proj / "secret.env").write_text("TOKEN=1")
    (proj / "a.txt").write_text("a1")
    cp.finish_turn()
    plan = cp.undo()
    assert "secret.env" not in plan.delete + plan.restore + plan.skipped
    assert (proj / "secret.env").read_text() == "TOKEN=1"
    assert (proj / "a.txt").read_text() == "a0"


def test_unusable_store_never_raises(tmp_path, proj):
    (tmp_path / "store").write_text("a file, not a directory")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.record_before("a.txt")
    cp.note_shell("ls")
    cp.finish_turn()
    assert cp.mode == "files" and cp.note


def test_bad_state_file_is_treated_as_empty(tmp_path, proj):
    state = tmp_path / "store" / "checkpoints"
    state.mkdir(parents=True)
    (state / "state.json").write_text("[1, 2]")
    cp = _store(tmp_path, proj)
    with pytest.raises(NothingToUndo):
        cp.undo_plan()


@needs_git
@pytest.mark.parametrize("inside", [True, False])
def test_directory_replaced_by_symlink_with_same_names(tmp_path, proj, inside):
    target = proj / "vendor" / "lib" if inside else tmp_path / "elsewhere"
    target.mkdir(parents=True)
    (target / "a.py").write_bytes(b"vendored A")
    (target / "c.py").write_bytes(b"C")
    (proj / "lib").mkdir()
    (proj / "lib" / "a.py").write_bytes(b"A")
    (proj / "lib" / "b.py").write_bytes(b"B")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    shutil.rmtree(proj / "lib")
    os.symlink(target, proj / "lib")  # rm -rf lib && ln -s <target> lib
    cp.finish_turn()
    plan = cp.undo()
    assert plan.skipped == [] and plan.restore == ["lib/a.py", "lib/b.py"]
    assert not (proj / "lib").is_symlink()
    assert (proj / "lib" / "a.py").read_bytes() == b"A"
    assert (proj / "lib" / "b.py").read_bytes() == b"B"
    assert sorted(os.listdir(target)) == ["a.py", "c.py"]
    assert (target / "a.py").read_bytes() == b"vendored A"


@needs_git
def test_failed_parent_delete_never_acts_outside(tmp_path, proj, monkeypatch):
    outside = tmp_path / "outside"
    (outside / "x").mkdir(parents=True)  # an empty dir where d/x would land
    (proj / "d").mkdir()
    (proj / "d" / "x").write_text("file x")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.note_shell("(the turn ran a command)")
    shutil.rmtree(proj / "d")
    os.symlink(outside, proj / "d")
    cp.finish_turn()
    monkeypatch.setattr(CheckpointStore, "_delete", lambda self, paths: ["d: refused"])
    with pytest.raises(checkpoints.CheckpointError):
        cp.undo()
    assert (outside / "x").is_dir()
    assert os.listdir(outside) == ["x"]


def _count_git(monkeypatch, record):
    real_run = checkpoints.subprocess.run

    def run(args, **kw):
        record.append((args, kw.get("timeout")))
        if getattr(run, "fail_add", False) and "add" in args:
            raise subprocess.TimeoutExpired(args, kw.get("timeout"))
        return real_run(args, **kw)

    monkeypatch.setattr(checkpoints.subprocess, "run", run)
    return run


@needs_git
def test_no_end_retry_after_too_many_files(tmp_path, proj, monkeypatch):
    (proj / "a.txt").write_text("a")
    cp = _store(tmp_path, proj, max_files=5)
    cp.begin_turn("t1")
    assert cp.mode == "shadow"
    for i in range(10):
        (proj / f"f{i}.txt").write_text(str(i))
    calls = []
    _count_git(monkeypatch, calls)
    cp.finish_turn()
    assert cp.mode == "files" and "5" in cp.note
    assert not any("add" in args for args, _t in calls)


@needs_git
def test_end_retry_is_capped(tmp_path, proj, monkeypatch):
    (proj / "a.txt").write_text("a")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    calls = []
    run = _count_git(monkeypatch, calls)
    run.fail_add = True
    cp.finish_turn()
    adds = [t for args, t in calls if "add" in args]
    assert len(adds) == 2 and max(adds) <= 30


def test_hostile_state_entries_dropped(tmp_path, proj, monkeypatch):
    monkeypatch.setattr(checkpoints.shutil, "which", lambda *_a, **_k: None)
    (tmp_path / "sentinel").write_text("keep me")
    (proj / "a.txt").write_text("a")
    state = tmp_path / "store" / "checkpoints"
    state.mkdir(parents=True)
    import json
    (state / "state.json").write_text(json.dumps({"turns": [
        {"id": "x", "key": "../..", "mode": "files", "undone": False, "finished": True},
        {"id": "y", "key": ".", "mode": "files", "undone": False, "finished": True},
        {"key": "noid", "mode": "files", "undone": False, "finished": True},
    ]}))
    cp = _store(tmp_path, proj, keep=1)
    with pytest.raises(NothingToUndo):
        cp.undo_plan()
    cp.begin_turn("t1")
    cp.finish_turn()
    assert (tmp_path / "sentinel").read_text() == "keep me"
    assert (proj / "a.txt").read_text() == "a"


def test_files_turn_without_manifest_is_skipped_not_blocking(tmp_path, proj, monkeypatch):
    monkeypatch.setattr(checkpoints.shutil, "which", lambda *_a, **_k: None)
    (proj / "a.txt").write_text("a")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.record_before("a.txt")
    (proj / "a.txt").write_text("b")
    cp.finish_turn()
    cp.begin_turn("t2")
    shutil.rmtree(tmp_path / "store" / "checkpoints" / "t2")  # "checkpoints are off"
    cp.finish_turn()
    note = ["(no checkpoint was taken for this turn)"]
    plan = cp.undo_plan()
    assert plan.turn_id == "t2" and plan.skipped == note and not plan.restore and not plan.conflicts
    done = cp.undo()
    assert done.turn_id == "t2" and done.skipped == note
    assert cp.undo().turn_id == "t1"           # the older turn is not blocked
    assert (proj / "a.txt").read_text() == "a"


# ── R27: tool writes to ignored / excluded files are undone too ──────────────

@needs_git
def test_undo_covers_tool_writes_to_ignored_and_excluded_files(tmp_path, proj):
    (proj / ".gitignore").write_text(".env\n")
    (proj / ".env").write_text("SECRET=old\n")
    (proj / "a.txt").write_text("a0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.record_before(str(proj / ".env"))
    (proj / ".env").write_text("SECRET=agent\n")
    cp.record_before(str(proj / "build" / "out.js"))
    (proj / "build").mkdir()
    (proj / "build" / "out.js").write_text("made by the agent")
    cp.record_before(str(proj / "a.txt"))
    (proj / "a.txt").write_text("a1")
    cp.finish_turn()
    plan = cp.undo_plan()
    assert plan.restore == [".env", "a.txt"]
    assert plan.delete == ["build/out.js"]
    assert plan.skipped == [] and plan.conflicts == []
    cp.undo()
    assert (proj / ".env").read_text() == "SECRET=old\n"
    assert not (proj / "build" / "out.js").exists()
    assert (proj / "a.txt").read_text() == "a0"


@needs_git
def test_user_change_to_ignored_file_after_the_turn_is_a_conflict(tmp_path, proj):
    (proj / ".gitignore").write_text(".env\n")
    (proj / ".env").write_text("SECRET=old\n")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.record_before(str(proj / ".env"))
    (proj / ".env").write_text("SECRET=agent\n")
    cp.finish_turn()
    (proj / ".env").write_text("SECRET=user\n")
    with pytest.raises(UndoConflict) as err:
        cp.undo()
    assert err.value.plan.conflicts == [".env"]
    assert (proj / ".env").read_text() == "SECRET=user\n"
    cp.undo(force=True)
    assert (proj / ".env").read_text() == "SECRET=old\n"


# ── R28: a shell-less turn never silently reverts the user's own edits ───────

@needs_git
def test_shell_less_turn_makes_concurrent_user_edit_a_conflict(tmp_path, proj):
    (proj / "a.txt").write_text("a0")
    (proj / "README.md").write_text("readme 0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.record_before(str(proj / "a.txt"))
    (proj / "a.txt").write_text("a1")
    (proj / "README.md").write_text("edited in an editor meanwhile")
    cp.finish_turn()
    plan = cp.undo_plan()
    assert plan.conflicts == ["README.md"]
    assert set(plan.restore) == {"a.txt", "README.md"}
    with pytest.raises(UndoConflict):
        cp.undo()
    assert (proj / "a.txt").read_text() == "a1"
    cp.undo(force=True)
    assert (proj / "a.txt").read_text() == "a0"
    assert (proj / "README.md").read_text() == "readme 0"


@needs_git
def test_turn_with_shell_reverts_everything_it_changed(tmp_path, proj):
    (proj / "a.txt").write_text("a0")
    (proj / "README.md").write_text("readme 0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t1")
    cp.record_before(str(proj / "a.txt"))
    (proj / "a.txt").write_text("a1")
    cp.note_shell("make docs")
    (proj / "README.md").write_text("written by make docs")
    cp.finish_turn()
    plan = cp.undo()
    assert plan.conflicts == [] and plan.restore == ["README.md", "a.txt"]
    assert (proj / "README.md").read_text() == "readme 0"


# ── R29: two processes on one project see each other's turns ─────────────────

@needs_git
def test_checkpoint_state_is_shared_across_processes(tmp_path, proj):
    (proj / "a.txt").write_text("a0")
    ui = _store(tmp_path, proj)          # the full-screen app's process
    cli = _store(tmp_path, proj)         # a headless `aihub-code -p` run
    ui.begin_turn("ui-1")
    ui.note_shell("x")
    (proj / "a.txt").write_text("a1")
    ui.finish_turn()
    cli.begin_turn("cli-1")
    cli.note_shell("y")
    (proj / "b.txt").write_text("b")
    cli.finish_turn()
    assert ui.undo_plan().turn_id == "cli-1"
    cli.undo()
    assert ui.undo_plan().turn_id == "ui-1"
    ui.begin_turn("ui-2")
    ui.finish_turn()
    import json
    with open(tmp_path / "store" / "checkpoints" / "state.json", encoding="utf-8") as fh:
        turns = json.load(fh)["turns"]
    assert [t["id"] for t in turns] == ["ui-1", "cli-1", "ui-2"]
    assert [t["undone"] for t in turns] == [False, True, False]


@needs_git
def test_turns_pruned_by_another_process_stay_gone(tmp_path, proj):
    (proj / "a.txt").write_text("a0")
    ui = _store(tmp_path, proj, keep=2)
    cli = _store(tmp_path, proj, keep=2)
    ui.begin_turn("ui-1")
    ui.finish_turn()
    for n in range(3):
        cli.begin_turn(f"cli-{n}")
        cli.finish_turn()
    assert ui.undo_plan().turn_id == "cli-2"
    ui.begin_turn("ui-2")
    ui.finish_turn()
    import json
    with open(tmp_path / "store" / "checkpoints" / "state.json", encoding="utf-8") as fh:
        assert [t["id"] for t in json.load(fh)["turns"]] == ["cli-2", "ui-2"]


@needs_git
def test_own_turn_kept_when_the_state_file_cannot_be_written(tmp_path, proj, monkeypatch):
    (proj / "a.txt").write_text("a0")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t0")
    cp.finish_turn()
    real = checkpoints._write_json

    def failing(path, data):
        if path.endswith("state.json"):
            raise OSError(28, "No space left on device")
        return real(path, data)
    monkeypatch.setattr(checkpoints, "_write_json", failing)
    cp.begin_turn("t1")
    cp.note_shell("x")
    (proj / "a.txt").write_text("a1")
    cp.finish_turn()
    assert cp.undo_plan().turn_id == "t1"


# ── R34: a turn that changes ignore rules never deletes files silently ───────

@needs_git
def test_unignored_file_is_a_conflict_not_deleted(tmp_path, proj):
    (proj / ".gitignore").write_text(".env\n")
    (proj / ".env").write_text("SECRET=1")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t0")
    cp.record_before(str(proj / ".gitignore"))
    (proj / ".gitignore").write_text("")
    cp.note_shell("npm test")
    cp.finish_turn()
    with pytest.raises(UndoConflict) as err:
        cp.undo()
    assert err.value.plan.conflicts == [".env"]
    assert (proj / ".env").read_text() == "SECRET=1"
    cp.undo(force=True)
    assert not (proj / ".env").exists()
    assert (proj / ".gitignore").read_text() == ".env\n"


@needs_git
def test_unignored_file_with_a_pre_turn_copy_is_restored(tmp_path, proj):
    (proj / ".gitignore").write_text(".env\n")
    (proj / ".env").write_text("SECRET=1")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t0")
    cp.record_before(str(proj / ".gitignore"))
    (proj / ".gitignore").write_text("")
    cp.record_before(str(proj / ".env"))
    (proj / ".env").write_text("SECRET=2")
    cp.finish_turn()                      # no command ran
    plan = cp.undo()
    assert ".env" in plan.restore and ".env" not in plan.delete
    assert (proj / ".env").read_text() == "SECRET=1"
    assert (proj / ".gitignore").read_text() == ".env\n"


@needs_git
def test_shell_turn_with_copy_restores_unignored_file(tmp_path, proj):
    (proj / ".gitignore").write_text(".env\n")
    (proj / ".env").write_text("SECRET=1")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t0")
    cp.record_before(str(proj / ".env"))
    (proj / ".env").write_text("SECRET=2")
    cp.note_shell("sed -i d .gitignore")
    (proj / ".gitignore").write_text("")
    cp.finish_turn()
    plan = cp.undo()
    assert plan.conflicts == [] and ".env" in plan.restore
    assert (proj / ".env").read_text() == "SECRET=1"


@needs_git
def test_info_exclude_change_makes_new_paths_conflicts(tmp_path, proj):
    _git(proj, "init", "-q")
    (proj / ".git" / "info").mkdir(exist_ok=True)
    (proj / ".git" / "info" / "exclude").write_text("local.cfg\n")
    (proj / "local.cfg").write_text("mine")
    cp = _store(tmp_path, proj)
    cp.begin_turn("t0")
    cp.note_shell("echo > .git/info/exclude")
    (proj / ".git" / "info" / "exclude").write_text("")
    cp.finish_turn()
    with pytest.raises(UndoConflict) as err:
        cp.undo()
    assert err.value.plan.conflicts == ["local.cfg"]
    assert (proj / "local.cfg").read_text() == "mine"


# ── R35: an undo in any process wins ─────────────────────────────────────────

@needs_git
def test_undo_by_another_process_is_never_written_back(tmp_path, proj):
    import json
    (proj / "a.txt").write_text("a0")
    a = _store(tmp_path, proj)
    b = _store(tmp_path, proj)
    for n in (0, 1):
        a.begin_turn(f"t{n}")
        a.record_before(str(proj / "a.txt"))
        (proj / "a.txt").write_text(f"a{n + 1}")
        a.finish_turn()
    assert b.undo().turn_id == "t1"
    assert a.undo_plan().turn_id == "t0"
    a.begin_turn("t2")
    a.finish_turn()
    with open(tmp_path / "store" / "checkpoints" / "state.json", encoding="utf-8") as fh:
        turns = {t["id"]: t["undone"] for t in json.load(fh)["turns"]}
    assert turns == {"t0": False, "t1": True, "t2": False}


@needs_git
def test_a_key_begun_again_is_not_undone(tmp_path, proj):
    (proj / "a.txt").write_text("a0")
    a = _store(tmp_path, proj)
    b = _store(tmp_path, proj)
    a.begin_turn("t1")
    a.note_shell("x")
    (proj / "a.txt").write_text("a1")
    a.finish_turn()
    b.undo()
    a.begin_turn("t1")
    a.note_shell("x")
    (proj / "a.txt").write_text("a2")
    a.finish_turn()
    assert a.undo_plan().turn_id == "t1"
    assert b.undo_plan().turn_id == "t1"


def test_a_windows_link_target_loses_the_long_path_prefix(monkeypatch):
    # os.readlink on Windows hands back "\\?\C:\..." for a link made to
    # "C:\...": undo must restore the target as it was written.
    from aihub_code import checkpoints as cp
    monkeypatch.setattr(cp.os, "readlink", lambda p: "\\\\?\\C:\\Users\\alex\\target.txt")
    monkeypatch.setattr(cp.sys, "platform", "win32")
    assert cp._readlink("x") == "C:\\Users\\alex\\target.txt"
    monkeypatch.setattr(cp.os, "readlink", lambda p: "\\\\?\\UNC\\server\\share\\t.txt")
    assert cp._readlink("x") == "\\\\server\\share\\t.txt"
    monkeypatch.setattr(cp.os, "readlink", lambda p: "relative\\t.txt")
    assert cp._readlink("x") == "relative\\t.txt"
    monkeypatch.setattr(cp.sys, "platform", "linux")
    monkeypatch.setattr(cp.os, "readlink", lambda p: "\\\\?\\odd-but-legal-on-linux")
    assert cp._readlink("x") == "\\\\?\\odd-but-legal-on-linux"
