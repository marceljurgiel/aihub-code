import json
import os
import re
import shutil
import subprocess
import threading

import pytest

from .conftest import FakeBackend, text, tool_call

from aihub_code import session as hs
from aihub_code.checkpoints import CheckpointError, NothingToUndo, UndoConflict
from aihub_code.compaction import Compactor
from aihub_code.permissions import PLAN_DENIAL, Rule, RuleStore
from aihub_code.project import store_dir
from aihub_code.session import CodeSession, SessionStore
from aihub.tools import workdir as wd
from aihub_code.engine.turn import TurnOutcome

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git missing")

CODE_TOOLS = ["read_file", "edit_file", "write_file", "search_files",
              "list_files", "run_terminal", "todo_write"]
SUMMARY = "## Goal\ng\n## Done\nd\n## Files touched\nf\n## Decisions\nx\n## Next\nn"


@pytest.fixture
def proj(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", wd._session_dir)  # restored after the test
    monkeypatch.setattr("aihub.agents.agent_context", lambda *a, **k: (8192, "test"))
    root = tmp_path / "proj"
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    (root / "a.txt").write_bytes(b"one\nold\n")
    return root


def _run(s, backend, prompt="change it", ask=None, cancel=None):
    events = []
    outcome = hs.run_turn(s, prompt, emit=lambda k, d: events.append((k, d)), ask=ask,
                          cancel=cancel or threading.Event(), stream_fn=backend)
    return outcome, events


def _edit(old="old", new="new", path="a.txt"):
    return tool_call({"name": "edit_file", "args": {"path": path, "old": old, "new": new}})


def _tool_results(s):
    return [m["content"] for m in s.messages if m.get("role") == "tool"]


def test_turn_edits_file_and_undo_restores(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    before = len(s.messages)
    outcome, events = _run(s, FakeBackend([[_edit()], [text("done")]]))
    assert not outcome.cancelled and not outcome.error
    assert (proj / "a.txt").read_bytes() == b"one\nnew\n"
    kinds = [k for k, _ in events]
    assert "code_diff" in kinds
    cp = next(d for k, d in events if k == "code_checkpoint")
    assert cp == {"turn": s.turn_ids[-1], "mode": s.checkpoints.mode, "note": s.checkpoints.note}
    plan = s.undo(confirm=True)
    assert plan.turn_id == cp["turn"]
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"
    assert len(s.messages) == before
    assert s.turn_starts == [] and s.turn_ids == []


def test_plan_mode_refuses_edit_with_plan_text(proj):
    s = CodeSession.start(str(proj), "m", mode="plan")
    _run(s, FakeBackend([[_edit()], [text("my plan")]]))
    assert _tool_results(s) == [PLAN_DENIAL]
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"


def test_build_mode_asks_with_diff_and_remembers(proj):
    s = CodeSession.start(str(proj), "m", mode="build")
    asked = []

    def ask(payload):
        asked.append(payload)
        return True, "project"

    _run(s, FakeBackend([[_edit()], [text("done")]]), ask=ask)
    assert len(asked) == 1
    p = asked[0]
    assert p["name"] == "edit_file" and p["mode"] == "build"
    assert p["diff"]["added"] == 1 and p["diff"]["path"] == "a.txt"
    assert p["suggested_rule"] == {"tool": "edit_file", "pattern": None, "scope": "session"}
    _run(s, FakeBackend([[_edit("new", "newer")], [text("done")]]), ask=ask)
    assert len(asked) == 1
    assert (proj / "a.txt").read_bytes() == b"one\nnewer\n"
    fresh = RuleStore(os.path.join(store_dir(s.project.root), "rules.json"))
    assert Rule("edit_file", None, "project") in fresh.project()


def test_session_scope_rule_stays_in_memory(proj):
    s = CodeSession.start(str(proj), "m", mode="build")
    _run(s, FakeBackend([[_edit()], [text("done")]]), ask=lambda p: (True, "session"))
    assert Rule("edit_file", None, "session") in s.rules.session
    assert RuleStore(os.path.join(store_dir(s.project.root), "rules.json")).project() == []
    _run(s, FakeBackend([[_edit("new", "newer")], [text("done")]]), ask=None)
    assert (proj / "a.txt").read_bytes() == b"one\nnewer\n"


def test_headless_style_ask_none_refuses(proj):
    s = CodeSession.start(str(proj), "m", mode="build")
    _run(s, FakeBackend([[_edit()], [text("ok")]]), ask=None)
    [result] = _tool_results(s)
    assert result.startswith("Refused:")
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"


def test_cancel_during_approval_keeps_undo(proj):
    s = CodeSession.start(str(proj), "m", mode="build")
    cancel = threading.Event()

    def ask(payload):
        cancel.set()
        return False, None

    backend = FakeBackend([[tool_call({"name": "edit_file", "args": {"path": "a.txt", "old": "old", "new": "x"}},
                                      {"name": "write_file", "args": {"path": "b.txt", "content": "b"}})],
                           [text("never")]])
    outcome, _ = _run(s, backend, ask=ask, cancel=cancel)
    assert outcome.cancelled
    for i, m in enumerate(s.messages):
        if m.get("role") == "assistant" and m.get("tool_calls"):
            answers = s.messages[i + 1:i + 1 + len(m["tool_calls"])]
            assert [a.get("role") for a in answers] == ["tool"] * len(m["tool_calls"])
    plan = s.undo(confirm=False)
    assert plan.turn_id == s.turn_ids[-1]
    assert (proj / "a.txt").read_bytes() == b"one\nold\n" and not (proj / "b.txt").exists()


def test_round_limit_ends_cleanly(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    backend = FakeBackend([[tool_call({"name": "read_file", "args": {"path": "a.txt"}})]] * 70)
    outcome, events = _run(s, backend)
    assert "[Stopped after 60 tool rounds" in outcome.final_text
    assert not any(k == "chat_error" and d.get("fatal") for k, d in events)
    assert backend.calls == 60


def test_compaction_runs_between_rounds(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    for i in range(3):
        s.messages += [{"role": "user", "content": f"request {i} " + "u" * 400},
                       {"role": "assistant", "content": f"answer {i} " + "a" * 400}]
    s.used_tokens = 7000          # the last reply reported a nearly full context
    outcome, events = _run(s, FakeBackend([[text(SUMMARY)], [text("reply")]]), prompt="next")
    kinds = [k for k, _ in events]
    assert "code_compaction" in kinds
    comp = dict(events)["code_compaction"]
    assert comp["method"] == "summary"
    reply = next(i for i, (k, d) in enumerate(events) if k == "text" and d["text"] == "reply")
    assert kinds.index("code_compaction") < reply
    ctx = [d for k, d in events if k == "code_context"]
    assert ctx and ctx[0]["limit"] == 8192
    assert s.used_tokens < 7000
    # The current request survived and its turn start points at it.
    assert s.messages[s.turn_starts[-1]]["content"] == "next"
    assert outcome.final_text == "reply"


def test_compaction_keeps_message_identity():
    msgs = [{"role": "system", "content": "s"}]
    for i in range(4):
        msgs += [{"role": "user", "content": f"q{i} " + "u" * 3000},
                 {"role": "assistant", "content": f"a{i} " + "a" * 3000}]
    orig = list(msgs)
    Compactor(lambda m: "bad").maybe_compact(msgs, 8192, force=True)
    assert len(msgs) < len(orig)
    assert msgs[0] is orig[0] and msgs[-2] is orig[-2] and msgs[-1] is orig[-1]
    new = [m for m in msgs if not any(m is o for o in orig)]
    assert len(new) == 1 and new[0]["content"].startswith("[Conversation summary]")


def test_mcp_and_kb_opt_in(proj, monkeypatch):
    demo = {"type": "function", "function": {"name": "demo__search", "parameters": {}}}
    monkeypatch.setattr("aihub_code.tools.schemas_for_agent",
                        lambda entries: [demo] if "mcp:demo" in entries else [])
    s = CodeSession.start(str(proj), "m")
    backend = FakeBackend([[text("hi")]])
    _run(s, backend)
    assert [t["function"]["name"] for t in backend.tools_seen[0]] == CODE_TOOLS
    h = s.hooks(emit=lambda *a: None, stream_fn=backend, cancel_check=lambda: False)
    assert h.max_tool_rounds == 60
    assert [t["function"]["name"] for t in h.tools_schema()] == CODE_TOOLS

    s2 = CodeSession.start(str(proj), "m", mcp=["mcp:demo"], knowledge=["notes"])
    h2 = s2.hooks(emit=lambda *a: None, stream_fn=backend, cancel_check=lambda: False)
    assert [t["function"]["name"] for t in h2.tools_schema()] == CODE_TOOLS + ["demo__search"]
    seen = {}

    def fake_drive(p, *, emit, ask, cancel, stream_fn, hooks):
        seen.update(p)
        out = TurnOutcome(p["messages"], False)
        hooks.finish(out)
        return out

    monkeypatch.setattr(hs, "drive_turn", fake_drive)
    _run(s2, backend)
    assert seen["knowledge"] == ["notes"] and seen["tools_enabled"] is True
    assert seen["model"] == "m" and seen["context_length"] == 8192


def test_session_saved_and_resumed(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    todos = [{"content": "step one", "status": "in_progress"}]
    _run(s, FakeBackend([[tool_call({"name": "todo_write", "args": {"todos": todos}})],
                         [text("working")]]), prompt="Build the thing")
    s.set_mode("plan")
    listed = SessionStore(store_dir(s.project.root)).list()
    assert [e["id"] for e in listed] == [s.id]
    assert listed[0]["title"] == "Build the thing" and listed[0]["turns"] == 1
    r = CodeSession.resume(str(proj), s.id)
    assert r.messages == s.messages
    assert r.mode == "plan"
    assert r.todo.items == todos
    assert r.turn_starts == s.turn_starts and r.turn_ids == s.turn_ids
    assert r.project.root == s.project.root and r.context_length == 8192
    r.undo(confirm=True)              # the resumed session can undo its turn
    assert r.messages == s.messages[:1]


def test_store_errors_and_ids(proj, caplog):
    s1 = CodeSession.start(str(proj), "m")
    s2 = CodeSession.start(str(proj), "m")
    assert s1.id != s2.id
    assert re.fullmatch(r"\d{8}-\d{6}(-\d+)?", s1.id)
    store = SessionStore(store_dir(s1.project.root))
    with pytest.raises(FileNotFoundError):
        store.load("nope")
    with pytest.raises(FileNotFoundError):
        store.load("../x")
    os.makedirs(os.path.join(store.store, "sessions"), exist_ok=True)
    with open(os.path.join(store.store, "sessions", "bad.json"), "w") as f:
        f.write("{not json")
    with pytest.raises(ValueError):
        store.load("bad")
    assert store.list() == []
    # A save that fails is logged, never raised.
    blocked = SessionStore(os.path.join(str(proj), "a.txt"))
    blocked.save(s1)
    assert "could not save" in caplog.text


def test_undo_refuses_other_sessions_turn(proj):
    a = CodeSession.start(str(proj), "m", mode="auto")
    b = CodeSession.start(str(proj), "m", mode="auto")
    _run(a, FakeBackend([[_edit()], [text("a done")]]))
    _run(b, FakeBackend([[tool_call({"name": "write_file", "args": {"path": "b.txt", "content": "b"}})],
                         [text("b done")]]))
    messages = list(a.messages)
    for confirm in (False, True):
        with pytest.raises(CheckpointError, match="another session"):
            a.undo(confirm=confirm)
    assert (proj / "a.txt").read_bytes() == b"one\nnew\n" and (proj / "b.txt").read_text() == "b"
    assert a.messages == messages and len(a.turn_ids) == 1
    b.undo(confirm=True)
    a.undo(confirm=True)
    assert (proj / "a.txt").read_bytes() == b"one\nold\n" and not (proj / "b.txt").exists()


def test_nothing_to_undo(proj):
    s = CodeSession.start(str(proj), "m")
    with pytest.raises(NothingToUndo):
        s.undo(confirm=False)


def test_undo_after_compaction_keeps_history_consistent(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    _run(s, FakeBackend([[_edit()], [text("edited")]]), prompt="first")
    _run(s, FakeBackend([[text("x" * 12000)]]), prompt="second")
    result = s.compact(FakeBackend([[text("not a summary")]]))
    assert result.method == "fallback"
    assert s.turn_starts[0] is None
    assert s.messages[s.turn_starts[1]]["content"] == "second"
    s.undo(confirm=True)              # turn 2: its start survived → truncated
    assert all(m.get("content") != "second" for m in s.messages)
    n = len(s.messages)
    s.undo(confirm=True)              # turn 1: summarised away → a note instead
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"
    assert len(s.messages) == n + 1
    assert s.messages[-1] == {"role": "user", "content": "[The user undid the file changes of that turn.]"}
    assert s.turn_starts == [] and s.turn_ids == []


def test_turn_ids_unique_after_undo(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    _run(s, FakeBackend([[_edit()], [text("done")]]))
    first = s.turn_ids[-1]
    s.undo(confirm=True)
    _run(s, FakeBackend([[_edit("old", "again")], [text("done")]]))
    second = s.turn_ids[-1]
    assert first != second
    for tid in (first, second):
        assert re.fullmatch(re.escape(s.id) + r"-[0-9a-f]{8}", tid)
    s.undo(confirm=True)
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"


def test_undo_conflict_propagates_and_keeps_messages(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    _run(s, FakeBackend([[_edit()], [text("done")]]))
    (proj / "a.txt").write_bytes(b"changed by hand\n")
    messages, starts, ids = list(s.messages), list(s.turn_starts), list(s.turn_ids)
    with pytest.raises(UndoConflict):
        s.undo(confirm=True)
    assert s.messages == messages and s.turn_starts == starts and s.turn_ids == ids
    assert (proj / "a.txt").read_bytes() == b"changed by hand\n"
    s.undo(confirm=True, force=True)
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"


def test_set_mode_validates(proj):
    s = CodeSession.start(str(proj), "m")
    with pytest.raises(ValueError):
        s.set_mode("yolo")
    with pytest.raises(ValueError):
        CodeSession.start(str(proj), "m", mode="yolo")
    s.set_mode("auto")
    assert s.mode == "auto"


def test_saved_json_fields(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    _run(s, FakeBackend([[text("hi")]]), prompt="hello")
    path = os.path.join(store_dir(s.project.root), "sessions", s.id + ".json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    for key in ("id", "cwd", "model", "stream_model", "backend", "mode", "context_length",
                "messages", "todos", "turn_starts", "turn_ids", "used_tokens", "updated"):
        assert key in data
    assert data["turn_ids"] == s.turn_ids


def test_undo_resets_used_tokens_no_needless_compaction(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    for q in range(3):
        _run(s, FakeBackend([[text("answer " + "a" * 400)]]), f"question {q}")
    _run(s, FakeBackend([[_edit()], [text("done")]]), "second")
    s.used_tokens = 7500          # the turn's last Usage was nearly full
    s.undo(confirm=True)
    assert s.used_tokens == hs.estimate_tokens(s.messages)
    backend = FakeBackend([[text("reply")]])
    outcome, events = _run(s, backend, "hello")
    assert not any(k == "code_compaction" for k, _ in events)
    assert backend.calls == 1 and outcome.final_text == "reply"


def test_image_in_old_history_survives_mid_turn_compaction(proj):
    from aihub import attachments as att
    from .helpers import png_bytes
    a = att.add_bytes(png_bytes(), "a.png")
    s = CodeSession.start(str(proj), "m", mode="auto")
    s.messages += [{"role": "user", "content": "look " + "u" * 400, "images": [a["id"]]},
                   {"role": "assistant", "content": "a red box " + "a" * 400}]
    for i in range(2):
        s.messages += [{"role": "user", "content": f"request {i} " + "u" * 400},
                       {"role": "assistant", "content": f"answer {i} " + "a" * 400}]
    s.used_tokens = 7000
    rounds = [[text(SUMMARY)]] + [[tool_call({"name": "read_file", "args": {"path": "a.txt"}})]] * 5 + [[text("ok")]]
    outcome, events = _run(s, FakeBackend(rounds), prompt="next")
    assert "code_compaction" in [k for k, _ in events] and outcome.final_text == "ok"
    assert not any("images" in m for m in s.messages)      # summarised away, never swapped back in
    for i, m in enumerate(s.messages):
        if m.get("role") == "assistant" and m.get("tool_calls"):
            assert s.messages[i + 1]["role"] == "tool"
        if m.get("role") == "tool":
            assert s.messages[i - 1].get("tool_calls")
    assert s.messages[s.turn_starts[-1]]["content"] == "next"


@pytest.mark.parametrize("answer", [("x", None), (1, "project"), (True, "forever")])
def test_approval_needs_a_real_yes_and_known_remember(proj, answer):
    s = CodeSession.start(str(proj), "m", mode="build")
    asked = []

    def ask(payload):
        asked.append(payload)
        return answer

    _run(s, FakeBackend([[_edit()], [text("done")]]), ask=ask)
    rules = RuleStore(os.path.join(store_dir(s.project.root), "rules.json"))
    assert rules.project() == [] and s.rules.session == []
    if answer[0] is True:
        assert (proj / "a.txt").read_bytes() == b"one\nnew\n"     # allowed once, nothing remembered
    else:
        assert (proj / "a.txt").read_bytes() == b"one\nold\n"
        assert _tool_results(s)[0].startswith("[Denied by user]")


def test_mcp_tool_asks_in_build_and_runs_when_allowed(proj, monkeypatch):
    demo = {"type": "function", "function": {"name": "demo__search", "parameters": {}}}
    monkeypatch.setattr("aihub_code.tools.schemas_for_agent",
                        lambda entries: [demo] if "mcp:demo" in entries else [])
    ran = []
    monkeypatch.setattr("aihub_code.tools.run_tool",
                        lambda name, **kw: ran.append((name, kw)) or "found it")
    s = CodeSession.start(str(proj), "m", mode="build", mcp=["mcp:demo"])
    asked = []
    _run(s, FakeBackend([[tool_call({"name": "demo__search", "args": {"q": "x"}})], [text("done")]]),
         ask=lambda p: asked.append(p) or (True, None))
    assert [p["name"] for p in asked] == ["demo__search"]
    assert ran == [("demo__search", {"q": "x"})] and _tool_results(s) == ["found it"]


def test_resume_clamps_bad_turn_starts(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    _run(s, FakeBackend([[text("hi")]]), prompt="hello")
    path = os.path.join(store_dir(s.project.root), "sessions", s.id + ".json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    data["turn_starts"] = [0, 99, "x", True, 1]
    data["turn_ids"] = ["a", "b", "c", "d", "e"]
    data["stream_model"] = 5
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    r = CodeSession.resume(str(proj), s.id)
    assert r.turn_starts == [None, None, None, None, 1]
    assert r.stream_model == "5"


def test_hooks_error_leaves_no_open_turn(proj, monkeypatch):
    s = CodeSession.start(str(proj), "m", mode="auto")
    before = list(s.messages)

    def boom(*a, **k):
        raise RuntimeError("no hooks")

    monkeypatch.setattr(CodeSession, "hooks", boom)
    with pytest.raises(RuntimeError):
        _run(s, FakeBackend([[text("hi")]]))
    assert s.messages == before and s.turn_ids == [] and s.turn_starts == []
    assert s.checkpoints._turn is None


def test_set_mode_saved_after_undo(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    _run(s, FakeBackend([[_edit()], [text("done")]]))
    s.undo(confirm=True)
    s.set_mode("plan")
    assert SessionStore(store_dir(s.project.root)).load(s.id)["mode"] == "plan"


def test_cancel_during_mid_turn_compaction_ends_the_turn_promptly(proj):
    s = CodeSession.start(str(proj), "m", mode="auto")
    for i in range(3):
        s.messages += [{"role": "user", "content": f"request {i} " + "u" * 400},
                       {"role": "assistant", "content": f"answer {i} " + "a" * 400}]
    s.used_tokens = 7000
    cancel = threading.Event()
    seen = {"calls": 0, "pulled": 0, "closed": 0}

    def backend(model, messages, temperature, context_length=None, tools=None):
        seen["calls"] += 1

        def gen():
            try:
                for i in range(1000):
                    seen["pulled"] += 1
                    if i == 1:
                        cancel.set()        # the user presses Esc mid-summary
                    yield text(SUMMARY[i % len(SUMMARY)])
            finally:
                seen["closed"] += 1
        return gen()

    outcome, events = _run(s, backend, prompt="next", cancel=cancel)
    assert outcome.cancelled is True
    assert seen["calls"] == 1                   # the model is not asked again
    assert seen["pulled"] <= 3 and seen["closed"] == 1
    comp = dict(events)["code_compaction"]
    assert comp["method"] == "fallback"
    assert s.messages[1]["content"].startswith("[Conversation summary]")
    assert s.messages[s.turn_starts[-1]]["content"] == "next"


def test_plan_mode_denies_tools_outside_the_schema(proj, monkeypatch):
    ran = []
    monkeypatch.setattr("aihub_code.tools.run_tool",
                        lambda name, **kw: ran.append(name) or "ran")
    s = CodeSession.start(str(proj), "m", mode="plan")
    _run(s, FakeBackend([[tool_call({"name": "remember", "args": {"fact": "x"}}),
                          tool_call({"name": "search_web", "args": {"query": "x"}})],
                         [text("plan")]]))
    assert ran == [] and _tool_results(s) == [PLAN_DENIAL, PLAN_DENIAL]


@pytest.mark.parametrize("mode", ["plan", "build", "auto"])
def test_mcp_tool_of_a_server_not_in_the_session_is_refused(proj, monkeypatch, mode):
    demo = {"type": "function", "function": {"name": "demo__search", "parameters": {}}}
    monkeypatch.setattr("aihub_code.tools.schemas_for_agent",
                        lambda entries: [demo] if "mcp:demo" in entries else [])
    monkeypatch.setattr("aihub_code.permissions.needs_approval", lambda name: False)
    monkeypatch.setattr("aihub_code.permissions.split_name",
                        lambda name: tuple(name.split("__", 1)))
    ran, asked = [], []
    monkeypatch.setattr("aihub_code.tools.run_tool",
                        lambda name, **kw: ran.append(name) or "ran")
    s = CodeSession.start(str(proj), "m", mode=mode, mcp=["demo"])
    _run(s, FakeBackend([[tool_call({"name": "gmail__send", "args": {"to": "x"}})], [text("ok")]]),
         ask=lambda p: asked.append(p) or (True, None))
    assert ran == [] and asked == []
    assert _tool_results(s)[0].startswith("Refused:")


@pytest.mark.parametrize("answer", [
    (False, None, "use pytest -x"),
    (False, "project", "use pytest -x"),
])
def test_denial_with_a_message_tells_the_model_what_to_do(proj, answer):
    s = CodeSession.start(str(proj), "m", mode="build")
    outcome, _ = _run(s, FakeBackend([[_edit()], [text("ok, pytest -x")]]), ask=lambda p: answer)
    assert not outcome.error
    assert _tool_results(s) == ["[Denied by user] The user said instead: use pytest -x"]
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"
    assert s.rules.session == []          # a denial never remembers anything


@pytest.mark.parametrize("answer", [
    (False, None), (False, None, None), (False, None, ""), (False, None, 5),
    (True, None, "ignored"),
])
def test_message_is_ignored_unless_a_denial_with_text(proj, answer):
    s = CodeSession.start(str(proj), "m", mode="build")
    _run(s, FakeBackend([[_edit()], [text("done")]]), ask=lambda p: answer)
    if answer[0] is True:
        assert (proj / "a.txt").read_bytes() == b"one\nnew\n"
    else:
        [result] = _tool_results(s)
        assert result.startswith("[Denied by user]") and "said instead" not in result
