"""aihub_code.engine.turn: the chat/agent turn without any bridge or stdout."""
from __future__ import annotations

import threading

import pytest

from aihub import agents
from aihub_code.engine import turn
from aihub_code.engine.chat import TextChunk

from .conftest import FakeBackend, text, tool_call


@pytest.fixture(autouse=True)
def clean():
    yield
    agents.delete_agent("alex-ask")


def ask_request():
    agents.save_agent(agents.AgentProfile(
        name="alex-ask", prompt="You help alex.", tools=["run_terminal"], permission="ask"))
    return {
        "model": "m", "backend": "ollama", "agent": True, "agent_name": "alex-ask",
        "submode": "build", "tools_enabled": True,
        "messages": [{"role": "user", "content": "list files"}],
    }


def ask_backend():
    return FakeBackend([
        [tool_call({"name": "run_terminal", "args": {"command": "ls"}})],
        [text("done")],
    ])


def test_drive_turn_without_bridge_streams_events(capsys):
    events = []
    outcome = turn.drive_turn(
        {"model": "m", "backend": "ollama", "tools_enabled": False,
         "messages": [{"role": "user", "content": "hi"}]},
        emit=lambda e, d=None: events.append((e, d)), ask=None,
        cancel=threading.Event(), stream_fn=FakeBackend([[text("hello")]]))
    assert outcome.final_text == "hello"
    assert ("final", {"text": "hello", "cancelled": False}) in events
    assert capsys.readouterr().out == ""


def test_unattended_ask_is_denied(tool_runs):
    events = []
    turn.drive_turn(ask_request(), emit=lambda e, d=None: events.append((e, d)), ask=None,
                    cancel=threading.Event(), stream_fn=ask_backend())
    assert "permission_request" not in [e for e, _ in events]
    assert tool_runs == []
    [result] = [d for e, d in events if e == "tool_result"]
    assert result["denied"] is True


def test_ask_callback_receives_payload(tool_runs):
    events, payloads = [], []

    def ask(payload):
        payloads.append(payload)
        return True, None

    turn.drive_turn(ask_request(), emit=lambda e, d=None: events.append((e, d)), ask=ask,
                    cancel=threading.Event(), stream_fn=ask_backend())
    [payload] = payloads
    assert payload["name"] == "run_terminal"
    assert payload["arguments"]
    assert len(tool_runs) == 1


def test_event_payload_matches_bridge():
    assert turn.event_payload(TextChunk("a", 0)) == ("text", {"text": "a", "round": 0})


class RecordingHooks:
    max_tool_rounds = 7

    def __init__(self):
        self.schema = [{"type": "function", "function": {"name": "code_tool"}}]
        self.ran, self.rounds, self.events, self.finished = [], [], [], []

    def tools_schema(self):
        return self.schema

    def system_prompt(self):
        return "HOOKS PROMPT"

    def approve(self, name, args, ask):
        return True

    def tool_runner(self, name, args):
        self.ran.append((name, args))
        return "hook result"

    def before_round(self, messages, round_index):
        self.rounds.append(round_index)

    def on_event(self, ev):
        self.events.append(ev)

    def finish(self, outcome):
        self.finished.append(outcome)


def test_drive_turn_uses_hooks(tool_runs):
    from aihub_code.engine.chat import Done
    hooks = RecordingHooks()
    backend = FakeBackend([
        [tool_call({"name": "code_tool", "args": {"x": 1}})],
        [text("done")],
    ])
    messages = [{"role": "user", "content": "do it"}]
    outcome = turn.drive_turn(
        {"model": "m", "backend": "ollama", "tools_enabled": True, "messages": messages},
        emit=lambda e, d=None: None, ask=None, cancel=threading.Event(),
        stream_fn=backend, hooks=hooks)

    assert backend.tools_seen[0] == hooks.schema
    assert messages[0]["role"] == "system"
    assert messages[0]["content"].startswith("HOOKS PROMPT")
    assert tool_runs == [] and hooks.ran == [("code_tool", {"x": 1})]
    assert hooks.rounds == [0, 1]
    assert hooks.finished == [outcome]
    assert any(isinstance(ev, Done) for ev in hooks.events)


def test_drive_turn_without_hooks_unchanged(tool_runs):
    call = [tool_call({"name": "run_terminal", "args": {"command": "ls"}})]
    events = []
    agents.save_agent(agents.AgentProfile(
        name="alex-ask", prompt="x", tools=["run_terminal"], permission="auto"))
    outcome = turn.drive_turn(
        {"model": "m", "backend": "ollama", "agent": True, "agent_name": "alex-ask",
         "tools_enabled": True, "messages": [{"role": "user", "content": "go"}]},
        emit=lambda e, d=None: events.append((e, d)), ask=None,
        cancel=threading.Event(), stream_fn=FakeBackend([call] * 25), hooks=None)

    assert "Tool-call loop limit reached (25 rounds)" in outcome.error
    assert any(e == "chat_error" and d["fatal"] for e, d in events)


def _hook_request(messages=None, **kw):
    return {"model": "m", "backend": "ollama", "tools_enabled": True,
            "messages": messages or [{"role": "user", "content": "check my mail"}], **kw}


def test_hooks_round_limit_and_approve_wiring(tool_runs):
    hooks = RecordingHooks()
    hooks.max_tool_rounds = 2
    seen = []
    hooks.approve = lambda name, args, ask: (seen.append(ask), "Plan mode: no")[1]
    ask = lambda payload: (True, None)
    call = [tool_call({"name": "code_tool", "args": {}})]
    events = []
    outcome = turn.drive_turn(
        _hook_request(), emit=lambda e, d=None: events.append((e, d)), ask=ask,
        cancel=threading.Event(), stream_fn=FakeBackend([call, call]), hooks=hooks)

    assert seen and all(a is ask for a in seen)
    results = [d for e, d in events if e == "tool_result"]
    assert results and all(r["result"] == "Plan mode: no" and r["denied"] for r in results)
    assert hooks.ran == []
    assert "[Stopped after 2 tool rounds" in outcome.final_text
    assert not any(e == "chat_error" for e, _ in events)
    assert outcome.error == ""


def test_hooks_skip_mcp_and_skill_catalog_and_add_safety_note(monkeypatch):
    mcp = [{"type": "function", "function": {"name": "mail__send"}}]
    monkeypatch.setattr("aihub.mcp_client.schemas_for_message", lambda text: mcp)
    monkeypatch.setattr("aihub.skills.catalog_prompt", lambda: "SKILL CATALOG HERE")
    hooks = RecordingHooks()
    backend = FakeBackend([[text("ok")]])
    messages = [{"role": "user", "content": "check my mail"}]
    turn.drive_turn(_hook_request(messages), emit=lambda e, d=None: None, ask=None,
                    cancel=threading.Event(), stream_fn=backend, hooks=hooks)
    assert backend.tools_seen[0] == hooks.schema
    assert "SKILL CATALOG HERE" not in messages[0]["content"]
    assert "<service>__<action>" not in messages[0]["content"]

    hooks2 = RecordingHooks()
    hooks2.schema = [{"type": "function", "function": {"name": "svc__act"}}]
    messages2 = [{"role": "user", "content": "hi"}]
    turn.drive_turn(_hook_request(messages2), emit=lambda e, d=None: None, ask=None,
                    cancel=threading.Event(), stream_fn=FakeBackend([[text("ok")]]), hooks=hooks2)
    assert "<service>__<action>" in messages2[0]["content"]


def test_finish_called_once_on_vision_refusal(monkeypatch):
    monkeypatch.setattr(turn, "no_vision_message", lambda model, backend: "no eyes")
    hooks = RecordingHooks()
    backend = FakeBackend([])
    outcome = turn.drive_turn(
        _hook_request([{"role": "user", "content": "look", "images": ["x"]}], backend="llamacpp"),
        emit=lambda e, d=None: None, ask=None, cancel=threading.Event(),
        stream_fn=backend, hooks=hooks)
    assert outcome.error == "no eyes" and backend.calls == 0
    assert hooks.finished == [outcome]


def test_finish_called_once_when_setup_raises():
    hooks = RecordingHooks()

    def boom():
        raise RuntimeError("bad prompt")
    hooks.system_prompt = boom
    with pytest.raises(RuntimeError):
        turn.drive_turn(_hook_request(), emit=lambda e, d=None: None, ask=None,
                        cancel=threading.Event(), stream_fn=FakeBackend([]), hooks=hooks)
    assert len(hooks.finished) == 1
    assert "bad prompt" in hooks.finished[0].error
