import pytest

from aihub_code import tools as ht
from aihub_code.todo import TodoList
from aihub.tools import workdir as wd


class FakeCP:
    def __init__(self, fail=False):
        self.before, self.shell, self.fail = [], [], fail

    def record_before(self, path):
        self.before.append(path)
        if self.fail:
            raise RuntimeError("boom")

    def note_shell(self, cmd):
        self.shell.append(cmd)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))
    events, cp = [], FakeCP()
    runner = ht.CodeToolRunner(todo=TodoList(), checkpoints=cp,
                               emit=lambda k, d: events.append((k, d)),
                               cancel_check=lambda: False, budget=8000)
    return tmp_path, runner, cp, events


def test_schema_names_exact():
    names = [t["function"]["name"] for t in ht.code_tools_schema()]
    assert names == ["read_file", "edit_file", "write_file", "search_files",
                     "list_files", "run_terminal", "todo_write"]
    term = ht.code_tools_schema()[5]["function"]
    assert "120" in term["parameters"]["properties"]["timeout"]["description"]
    assert "900" in term["parameters"]["properties"]["timeout"]["description"]


def test_read_numbered_offset(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))
    (tmp_path / "f.txt").write_text("".join(f"line{i}\n" for i in range(1, 11)))
    out = ht.read_numbered("f.txt", 4, 2)
    assert out.splitlines()[:2] == ["    4\tline4", "    5\tline5"]
    assert out.splitlines()[2] == "[lines 4-5 of 10 — call read_file with offset to read more]"


def test_read_numbered_binary_and_past_end(env):
    tmp, runner, _, _ = env
    (tmp / "b.bin").write_bytes(b"ab\x00cd")
    assert "looks like a binary file" in runner("read_file", {"path": "b.bin"})
    (tmp / "f.txt").write_text("a\nb\n")
    assert runner("read_file", {"path": "f.txt", "offset": 9}).endswith("has only 2 lines.")
    assert "File not found" in runner("read_file", {"path": "nope"})
    assert "    1\ta" in runner("read_file", {"path": "f.txt", "offset": "x", "limit": None})


def test_edit_emits_diff_and_records_before(env):
    tmp, runner, cp, events = env
    (tmp / "a.txt").write_text("one\nold\n")
    r = runner("edit_file", {"path": "a.txt", "old": "old", "new": "new"})
    assert "Error]" not in r and (tmp / "a.txt").read_text() == "one\nnew\n"
    assert cp.before == [str(tmp / "a.txt")]
    kind, d = events[0]
    assert kind == "code_diff" and d["added"] == 1


def test_failed_edit_gets_hint_and_no_diff(env):
    tmp, runner, _, events = env
    (tmp / "a.txt").write_text("x\n")
    r = runner("edit_file", {"path": "a.txt", "old": "zz", "new": "y"})
    assert r.endswith(ht.EDIT_HINT) and not events


def test_record_before_raising_still_edits(env):
    tmp, runner, cp, events = env
    cp.fail = True
    (tmp / "a.txt").write_text("old\n")
    r = runner("edit_file", {"path": "a.txt", "old": "old", "new": "new"})
    assert "Error]" not in r and (tmp / "a.txt").read_text() == "new\n"
    assert events


def test_emit_raising_keeps_result(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))

    def bad(k, d):
        raise RuntimeError("x")
    runner = ht.CodeToolRunner(todo=TodoList(), checkpoints=FakeCP(), emit=bad,
                               cancel_check=lambda: False, budget=100)
    assert "completed" in runner("todo_write", {"todos": [{"content": "a", "status": "completed"}]})


def test_todo_emits_todos(env):
    _, runner, _, events = env
    r = runner("todo_write", {"todos": [{"content": "a", "status": "pending"}]})
    assert "0/1" in r
    assert events == [("code_todos", {"todos": [{"content": "a", "status": "pending"}]})]


def test_shell_noted_and_timeout_passed(env, monkeypatch):
    _, runner, cp, _ = env
    seen = {}
    monkeypatch.setattr(ht, "run_shell", lambda cmd, **kw: seen.update(kw, cmd=cmd) or "ok")
    assert runner("run_terminal", {"command": "x", "timeout": 300}) == "ok"
    assert seen["timeout"] == 300 and cp.shell == ["x"]
    runner("run_terminal", {"command": "x", "timeout": "abc"})
    assert seen["timeout"] == 120


def test_missing_command(env):
    _, runner, _, _ = env
    assert runner("run_terminal", {}) == "[Tool Error] run_terminal needs 'command'."


def test_other_tools_go_to_run_tool(env, monkeypatch):
    _, runner, _, _ = env
    monkeypatch.setattr(ht, "run_tool", lambda name, **kw: f"{name}:{kw}")
    assert runner("list_files", {"directory": "."}) == "list_files:{'directory': '.'}"


def _unblock_fifo(path):
    import os
    try:
        fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
        os.close(fd)
    except OSError:
        pass


def _in_thread(fn, seconds=3):
    import threading
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("r", fn()), daemon=True)
    t.start()
    t.join(seconds)
    return t, out.get("r")


@pytest.mark.skipif(not hasattr(__import__("os"), "mkfifo"), reason="needs FIFOs")
def test_read_file_refuses_special_files(env):
    import os
    tmp, runner, _, _ = env
    fifo = tmp / "pipe"
    os.mkfifo(fifo)
    try:
        t, r = _in_thread(lambda: runner("read_file", {"path": "pipe"}))
        assert not t.is_alive(), "read_file blocked on a FIFO"
        assert r.startswith("[File Error]") and "not a regular file" in r
    finally:
        _unblock_fifo(fifo)
    r = runner("read_file", {"path": "/dev/null"})
    assert r.startswith("[File Error]") and "not a regular file" in r


def test_read_file_caps_huge_files(env):
    tmp, runner, _, _ = env
    line = "x" * 99 + "\n"
    (tmp / "big.log").write_text(line * 30000)          # 3 MB
    r = runner("read_file", {"path": "big.log", "limit": 3})
    assert r.splitlines()[0] == "    1\t" + "x" * 99
    assert "larger than 2 MB" in r
    far = runner("read_file", {"path": "big.log", "offset": 25000})
    assert far.startswith("[File Error]") and "larger than 2 MB" in far


def test_code_diff_only_for_a_clean_preview(env, monkeypatch):
    from aihub_code.diffs import Diff
    tmp, runner, _, events = env
    monkeypatch.setattr(ht, "preview", lambda name, args: Diff("a.txt", "", 0, 0, False,
                                                                 error="could not preview: boom"))
    r = runner("write_file", {"path": "a.txt", "content": "x"})
    assert "Error]" not in r and (tmp / "a.txt").read_text() == "x"
    assert not [k for k, _ in events if k == "code_diff"]


@pytest.mark.skipif(not hasattr(__import__("os"), "mkfifo"), reason="needs FIFOs")
@pytest.mark.parametrize("name,args", [("edit_file", {"old": "a", "new": "b"}),
                                       ("write_file", {"content": "x"})])
def test_write_tools_refuse_special_files(env, name, args):
    import os
    tmp, runner, _, _ = env
    fifo = tmp / "pipe"
    os.mkfifo(fifo)
    try:
        t, r = _in_thread(lambda: runner(name, {"path": "pipe", **args}))
        assert not t.is_alive(), f"{name} blocked on a FIFO"
        assert "Not a regular file" in r
    finally:
        _unblock_fifo(fifo)
