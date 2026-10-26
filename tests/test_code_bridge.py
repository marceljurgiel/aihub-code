"""bridge code.* methods: coding sessions over the NDJSON bridge."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading

import pytest

from aihub_code import bridge
from aihub_code.engine.filelock import try_file_lock
from aihub_code.project import store_dir
from aihub.tools import workdir as wd

from .conftest import FakeBackend, text, tool_call

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git missing")


@pytest.fixture
def wire(monkeypatch):
    out = {"events": [], "done": None, "error": None}

    def fake_emit(req_id, event, data=None):
        out["events"].append((event, data))
        hook = out.get("on_emit")
        if hook:
            hook(req_id, event, data)

    monkeypatch.setattr(bridge, "_emit", fake_emit)
    monkeypatch.setattr(bridge, "_done", lambda req_id, data=None: out.__setitem__("done", data))
    monkeypatch.setattr(bridge, "_error", lambda req_id, msg: out.__setitem__("error", str(msg)))
    monkeypatch.setattr(bridge, "_code", None)
    monkeypatch.setattr(bridge, "_code_busy", False)
    monkeypatch.setattr(wd, "_session_dir", wd._session_dir)
    monkeypatch.setattr("aihub.agents.agent_context", lambda *a, **k: (8192, "test"))
    return out


@pytest.fixture
def proj(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    (root / "a.txt").write_bytes(b"one\nold\n")
    return root


def call(wire, method, params=None, req_id=1):
    wire["done"] = wire["error"] = None
    bridge._run(req_id, method, params or {})
    return wire["done"]


def start(wire, proj, **kw):
    return call(wire, "code.start", {"cwd": str(proj), "model": "m", **kw})


def use(monkeypatch, backend):
    monkeypatch.setattr(bridge, "_resolve_stream_fn", lambda m, b: backend)


def _edit():
    return tool_call({"name": "edit_file", "args": {"path": "a.txt", "old": "old", "new": "new"}})


def test_code_start_returns_project(wire, proj):
    d = start(wire, proj)
    assert d["session_id"] and d["project"]["is_git"] is True
    assert d["mode"] == "build" and d["context_length"] == 8192
    assert d["rules"] == [] and set(d["checkpoints"]) == {"mode", "note"}
    assert d["model"] == "m"        # a resumed session's model is known only here
    assert set(d["project"]) == {"root", "branch", "dirty_total", "instruction_file", "is_git"}


def test_methods_need_session(wire):
    call(wire, "code.mode", {"mode": "auto"})
    assert wire["error"] == "no code session — call code.start first"
    use_none = call(wire, "code.todos")
    assert use_none is None and "code.start" in wire["error"]


def test_code_turn_round_trip_and_undo(wire, proj, monkeypatch):
    start(wire, proj, mode="auto")
    use(monkeypatch, FakeBackend([[_edit()], [text("fixed")]]))
    call(wire, "code.turn", {"text": "change it"}, req_id=7)
    kinds = [e for e, _ in wire["events"]]
    for k in ("tool_result", "code_diff", "code_checkpoint", "final"):
        assert k in kinds
    assert wire["done"]["cancelled"] is False and wire["done"]["messages"]
    assert (proj / "a.txt").read_bytes() == b"one\nnew\n"
    assert not bridge._cancel_events and not bridge._perm_queues

    plan = call(wire, "code.undo", {})
    assert plan["restore"] == ["a.txt"] and plan["applied"] is False and "skipped" in plan
    assert (proj / "a.txt").read_bytes() == b"one\nnew\n"
    done = call(wire, "code.undo", {"confirm": True})
    assert done["applied"] is True and "skipped" in done
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"
    call(wire, "code.undo", {})
    assert wire["error"] == "nothing to undo"


def test_undo_conflict_reports_plan(wire, proj, monkeypatch):
    start(wire, proj, mode="auto")
    use(monkeypatch, FakeBackend([[_edit()], [text("fixed")]]))
    call(wire, "code.turn", {"text": "change it"})
    (proj / "a.txt").write_bytes(b"edited by hand\n")
    d = call(wire, "code.undo", {"confirm": True})
    assert d["applied"] is False and d["conflicts"] == ["a.txt"]
    assert (proj / "a.txt").read_bytes() == b"edited by hand\n"


def test_undo_checkpoint_error_message(wire, proj, monkeypatch):
    from aihub_code.checkpoints import CheckpointError
    start(wire, proj)

    def boom(*, confirm, force=False):
        raise CheckpointError("the snapshot is gone")

    monkeypatch.setattr(bridge._code, "undo", boom, raising=False)
    call(wire, "code.undo", {})
    assert wire["error"] == "the snapshot is gone"


def test_permission_remember_project(wire, proj, monkeypatch):
    start(wire, proj)               # build mode: an edit asks
    use(monkeypatch, FakeBackend([[_edit()], [text("ok")]]))

    def on_emit(req_id, event, data):
        if event == "permission_request":
            bridge._dispatch(json.dumps({"method": "chat.permission", "params": {
                "request_id": 5, "allow": True, "remember": "project"}}))

    wire["on_emit"] = on_emit
    call(wire, "code.turn", {"text": "go"}, req_id=5)
    assert (proj / "a.txt").read_bytes() == b"one\nnew\n"
    rules = call(wire, "code.rules.list")["rules"]
    assert [(r["tool"], r["scope"]) for r in rules] == [("edit_file", "project")]


def test_string_false_does_not_approve(wire, proj, monkeypatch):
    start(wire, proj)
    use(monkeypatch, FakeBackend([[_edit()], [text("no")]]))

    def on_emit(req_id, event, data):
        if event == "permission_request":
            bridge._dispatch(json.dumps({"method": "chat.permission", "params": {
                "request_id": 5, "allow": "false"}}))

    wire["on_emit"] = on_emit
    call(wire, "code.turn", {"text": "go"}, req_id=5)
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"


def test_chat_permission_plain_bool_without_remember(monkeypatch):
    import queue
    q = queue.Queue()
    monkeypatch.setattr(bridge, "_perm_queues", {9: q})
    bridge._dispatch(json.dumps({"method": "chat.permission",
                                 "params": {"request_id": 9, "allow": True}}))
    assert q.get_nowait() is True
    bridge._dispatch(json.dumps({"method": "chat.permission",
                                 "params": {"request_id": 9, "allow": True, "remember": "session"}}))
    assert q.get_nowait() == (True, "session")


def test_cancel_unblocks_permission(wire, proj, monkeypatch):
    start(wire, proj)
    use(monkeypatch, FakeBackend([[_edit()], [text("x")]]))

    def on_emit(req_id, event, data):
        if event == "permission_request":
            bridge._dispatch(json.dumps({"method": "chat.cancel", "params": {"request_id": 6}}))

    wire["on_emit"] = on_emit
    call(wire, "code.turn", {"text": "go"}, req_id=6)
    assert wire["done"]["cancelled"] is True
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"


def test_busy_project_lock_is_an_error(wire, proj, monkeypatch):
    d = start(wire, proj)
    use(monkeypatch, FakeBackend([[text("x")]]))
    with try_file_lock(os.path.join(store_dir(d["project"]["root"]), "session.lock")):
        call(wire, "code.turn", {"text": "go"})
        assert wire["error"] == "Another aihub-code session is working in this project."
        call(wire, "code.compact")
        assert wire["error"] == "Another aihub-code session is working in this project."
        call(wire, "code.undo", {"confirm": True})
        assert wire["error"] == "Another aihub-code session is working in this project."
    assert bridge._code_busy is False


def test_start_and_resume_refused_while_turn_runs(wire, proj, monkeypatch):
    start(wire, proj)
    use(monkeypatch, FakeBackend([[text("x")]]))
    seen = {}

    def on_emit(req_id, event, data):
        if event == "text" and "r" not in seen:
            seen["r"] = start(wire, proj) , wire["error"]
            wire["error"] = None
            call(wire, "code.resume", {"cwd": str(proj), "session_id": "nope"})
            seen["e2"] = wire["error"]

    wire["on_emit"] = on_emit
    call(wire, "code.turn", {"text": "go"})
    assert seen["r"][1] == "a turn is running" and seen["e2"] == "a turn is running"


def test_resume_and_sessions(wire, proj, monkeypatch):
    first = start(wire, proj)
    use(monkeypatch, FakeBackend([[text("hello")]]))
    call(wire, "code.turn", {"text": "hi there"})
    listed = call(wire, "code.sessions", {"cwd": str(proj)})["sessions"]
    assert listed[0]["id"] == first["session_id"]
    d = call(wire, "code.resume", {"cwd": str(proj), "session_id": first["session_id"]})
    assert d["session_id"] == first["session_id"]
    assert [m["role"] for m in d["messages"]][-2:] == ["user", "assistant"]
    call(wire, "code.resume", {"cwd": str(proj), "session_id": "missing"})
    assert wire["error"]


def test_mode_rules_todos(wire, proj):
    start(wire, proj)
    assert call(wire, "code.mode", {"mode": "plan"}) == {"mode": "plan"}
    call(wire, "code.mode", {"mode": "bogus"})
    assert "unknown mode" in wire["error"]
    assert call(wire, "code.todos") == {"todos": []}
    added = call(wire, "code.rules.add", {"tool": "run_terminal", "pattern": "ls", "scope": "session"})
    assert added["rules"] == [{"tool": "run_terminal", "pattern": "ls", "scope": "session"}]
    assert call(wire, "code.rules.remove", {"tool": "run_terminal", "pattern": "ls",
                                            "scope": "session"})["rules"] == []


def test_compact_emits_event(wire, proj, monkeypatch):
    start(wire, proj)
    use(monkeypatch, FakeBackend([[text("a")]]))
    call(wire, "code.turn", {"text": "hi"})
    d = call(wire, "code.compact")
    assert set(d["result"]) == {"method", "before", "after", "kept_turns"}
    assert wire["events"][-1][0] == "code_compaction"


def test_start_refused_while_busy_and_flag_released_after_failure(wire, proj, monkeypatch):
    start(wire, proj)
    old = bridge._code
    monkeypatch.setattr(bridge, "_code_busy", True)
    start(wire, proj)
    assert wire["error"] == "a turn is running" and bridge._code is old
    monkeypatch.setattr(bridge, "_code_busy", False)
    call(wire, "code.start", {"cwd": str(proj), "model": "m", "mode": "bogus"})
    assert "unknown mode" in wire["error"]
    assert bridge._code_busy is False and bridge._code is old


def test_start_holds_busy_flag_while_building(wire, proj, monkeypatch):
    from aihub_code.session import CodeSession
    real, seen = CodeSession.start, {}

    def slow(*a, **k):
        seen["busy"] = bridge._code_busy
        return real(*a, **k)

    monkeypatch.setattr(CodeSession, "start", slow)
    start(wire, proj)
    assert seen["busy"] is True and bridge._code_busy is False


def test_turn_reads_the_session_once(wire, proj, monkeypatch):
    start(wire, proj)
    use(monkeypatch, FakeBackend([[text("x")]]))
    real, n = bridge._code_session, []
    monkeypatch.setattr(bridge, "_code_session", lambda: n.append(1) or real())
    call(wire, "code.turn", {"text": "go"})
    assert len(n) == 1
    call(wire, "code.compact")
    assert len(n) == 2


def test_mode_refused_while_turn_runs(wire, proj, monkeypatch):
    start(wire, proj)
    monkeypatch.setattr(bridge, "_code_busy", True)
    call(wire, "code.mode", {"mode": "auto"})
    assert wire["error"] == "a turn is running" and bridge._code.mode == "build"


def test_rules_need_tool(wire, proj):
    start(wire, proj)
    call(wire, "code.rules.add", {"scope": "session"})
    assert wire["error"] == "code.rules.add needs 'tool'"
    call(wire, "code.rules.remove", {})
    assert wire["error"] == "code.rules.remove needs 'tool'"


def test_failed_turn_leaves_session_usable(wire, proj, monkeypatch):
    start(wire, proj)

    def boom(*a, **k):
        raise RuntimeError("backend died")

    from aihub_code import session as sess
    real = sess.run_turn
    monkeypatch.setattr(sess, "run_turn", boom)
    call(wire, "code.turn", {"text": "one"})
    assert "backend died" in wire["error"] and bridge._code_busy is False
    assert not bridge._cancel_events and not bridge._perm_queues
    monkeypatch.setattr(sess, "run_turn", real)
    monkeypatch.setattr(bridge, "_resolve_stream_fn", lambda m, b: FakeBackend([[text("fine")]]))
    d = call(wire, "code.turn", {"text": "two"})
    assert d["cancelled"] is False and wire["error"] is None


def test_undo_preview_takes_the_project_lock(wire, proj, monkeypatch):
    d = start(wire, proj, mode="auto")
    use(monkeypatch, FakeBackend([[_edit()], [text("fixed")]]))
    call(wire, "code.turn", {"text": "change it"})
    with try_file_lock(os.path.join(store_dir(d["project"]["root"]), "session.lock")):
        assert call(wire, "code.undo", {}) is None
        assert wire["error"] == "Another aihub-code session is working in this project."
    assert call(wire, "code.undo", {})["restore"] == ["a.txt"]


@pytest.mark.parametrize("method,extra", [("code.start", {"model": "m"}),
                                          ("code.resume", {"session_id": "x"}),
                                          ("code.sessions", {})])
def test_missing_folder_is_refused(wire, tmp_path, method, extra):
    from aihub_code.project import project_key
    from aihub.config import CONFIG_DIR
    gone = tmp_path / "no-such-dir"
    assert call(wire, method, {"cwd": str(gone), **extra}) is None
    assert wire["error"] == f"no such folder: {gone}"
    assert not os.path.exists(os.path.join(CONFIG_DIR, "projects", project_key(str(gone))))


def test_sessions_of_a_new_folder_creates_no_store(wire, tmp_path):
    from aihub_code.project import project_key
    from aihub.config import CONFIG_DIR
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    assert call(wire, "code.sessions", {"cwd": str(fresh)}) == {"sessions": []}
    assert not os.path.exists(os.path.join(CONFIG_DIR, "projects", project_key(str(fresh))))


def test_permission_request_carries_an_id_and_stale_answers_are_dropped(wire, proj, monkeypatch):
    start(wire, proj)
    use(monkeypatch, FakeBackend([[_edit()], [text("ok")]]))
    ids = []

    def on_emit(req_id, event, data):
        if event == "permission_request":
            ids.append(data["permission_id"])
            # A late answer to an older prompt: dropped, the prompt still waits.
            bridge._dispatch(json.dumps({"method": "chat.permission", "params": {
                "request_id": 5, "allow": True, "permission_id": data["permission_id"] - 1}}))
            assert bridge._perm_queues[5].empty()
            bridge._dispatch(json.dumps({"method": "chat.permission", "params": {
                "request_id": 5, "allow": True, "permission_id": data["permission_id"]}}))

    wire["on_emit"] = on_emit
    call(wire, "code.turn", {"text": "go"}, req_id=5)
    assert len(ids) == 1 and isinstance(ids[0], int)
    assert (proj / "a.txt").read_bytes() == b"one\nnew\n"


def test_answer_with_an_id_but_no_pending_prompt_is_dropped(monkeypatch):
    import queue
    q = queue.Queue()
    monkeypatch.setattr(bridge, "_perm_queues", {9: q})
    bridge._dispatch(json.dumps({"method": "chat.permission",
                                 "params": {"request_id": 9, "allow": True, "permission_id": 3}}))
    assert q.empty()


def test_compact_can_be_cancelled(wire, proj, monkeypatch):
    start(wire, proj)
    use(monkeypatch, FakeBackend([[text("a" * 2000)] for _ in range(3)]))
    for word in ("one", "two", "three"):
        call(wire, "code.turn", {"text": word + " " + "x" * 2000})
    pulled = []

    def summariser(model, messages, temperature, context_length=None, tools=None):
        def gen():
            for i in range(1000):
                pulled.append(i)
                if i == 1:
                    bridge._dispatch(json.dumps({"method": "chat.cancel",
                                                 "params": {"request_id": 4}}))
                yield text("## Goal\n")
        return gen()

    use(monkeypatch, summariser)
    d = call(wire, "code.compact", req_id=4)
    assert d["result"]["method"] == "fallback" and len(pulled) <= 3
    assert not bridge._cancel_events


def test_duplicate_answer_never_pre_answers_the_next_prompt(wire, proj, monkeypatch):
    start(wire, proj)
    write_b = tool_call({"name": "write_file", "args": {"path": "b.txt", "content": "b"}})
    use(monkeypatch, FakeBackend([[_edit()], [write_b], [text("ok")]]))
    prompts = []

    def on_emit(req_id, event, data):
        if event == "permission_request":
            prompts.append(data["name"])
            if len(prompts) == 1:
                answer = {"request_id": 5, "allow": True, "permission_id": data["permission_id"]}
                for _ in range(2):          # the UI sent the same answer twice
                    bridge._dispatch(json.dumps({"method": "chat.permission", "params": answer}))
            else:
                bridge._dispatch(json.dumps({"method": "chat.permission", "params": {
                    "request_id": 5, "allow": False, "permission_id": data["permission_id"]}}))

    wire["on_emit"] = on_emit
    call(wire, "code.turn", {"text": "go"}, req_id=5)
    assert prompts == ["edit_file", "write_file"]
    assert (proj / "a.txt").read_bytes() == b"one\nnew\n"
    assert not (proj / "b.txt").exists()


def test_null_permission_id_with_nothing_pending_is_dropped(monkeypatch):
    import queue
    q = queue.Queue()
    monkeypatch.setattr(bridge, "_perm_queues", {9: q})
    bridge._dispatch(json.dumps({"method": "chat.permission",
                                 "params": {"request_id": 9, "allow": True, "permission_id": None}}))
    assert q.empty()
