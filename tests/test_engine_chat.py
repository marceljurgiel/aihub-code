"""run_chat_turn: cancellation and turn termination."""
from __future__ import annotations

from aihub_code.engine.chat import (
    Done, Error, TextChunk, ToolCallRequested, ToolCallResult, run_chat_turn,
)

from .conftest import SCHEMA, FakeBackend, text, tool_call


def _run(backend, messages=None, **kw):
    messages = messages if messages is not None else [{"role": "user", "content": "hi"}]
    events = list(run_chat_turn("m", messages, stream_fn=backend, **kw))
    return events, messages


def _assert_tool_calls_answered(messages):
    """Every assistant tool_calls entry must be followed by one tool result
    per call, or the next request to the backend is malformed."""
    for i, m in enumerate(messages):
        if m.get("role") == "assistant" and m.get("tool_calls"):
            n = len(m["tool_calls"])
            following = messages[i + 1:i + 1 + n]
            assert [f["role"] for f in following] == ["tool"] * n


def test_plain_turn_ends_with_single_done():
    backend = FakeBackend([[text("Hel"), text("lo")]])
    events, messages = _run(backend)

    assert [e.text for e in events if isinstance(e, TextChunk)] == ["Hel", "lo"]
    dones = [e for e in events if isinstance(e, Done)]
    assert len(dones) == 1 and events[-1] is dones[0]
    assert dones[0].cancelled is False
    assert messages[-1] == {"role": "assistant", "content": "Hello"}
    assert backend.closed == 1


def test_cancel_mid_stream_stops_reading_and_keeps_partial():
    backend = FakeBackend([[text("a"), text("b"), text("c"), text("d")]])
    events, messages = _run(backend, cancel_check=lambda: backend.pulled >= 2)

    assert [e.text for e in events if isinstance(e, TextChunk)] == ["a"]
    assert backend.pulled == 2          # stopped reading, didn't drain the stream
    assert backend.closed == 1          # closed → HTTP connection dropped
    assert isinstance(events[-1], Done) and events[-1].cancelled
    assert messages[-1] == {"role": "assistant", "content": "a"}


def test_cancel_before_any_output_adds_no_assistant_message():
    backend = FakeBackend([[text("a")]])
    events, messages = _run(backend, cancel_check=lambda: True)

    assert backend.calls == 0
    assert events == [Done(final_text="", cancelled=True)]
    assert messages == [{"role": "user", "content": "hi"}]


def test_cancel_after_stream_drops_pending_tool_calls(tool_runs):
    backend = FakeBackend([[tool_call({"name": "read_file", "args": {"path": "x"}})]])
    events, messages = _run(backend, tools_schema=SCHEMA,
                            cancel_check=lambda: backend.closed >= 1)

    assert tool_runs == []
    assert not any(isinstance(e, ToolCallRequested) for e in events)
    assert isinstance(events[-1], Done) and events[-1].cancelled
    assert not any(m.get("tool_calls") for m in messages)


def test_cancel_during_tools_skips_remaining_and_answers_them(monkeypatch):
    cancelled = {"flag": False}
    runs = []

    def run_tool(name, **kwargs):
        runs.append(name)
        cancelled["flag"] = True        # user hits Esc while the 1st tool runs
        return "ok"

    monkeypatch.setattr("aihub_code.engine.chat.run_tool", run_tool)
    backend = FakeBackend([[tool_call(
        {"name": "read_file", "args": {"path": "a"}},
        {"name": "read_file", "args": {"path": "b"}},
    )]])
    events, messages = _run(backend, tools_schema=SCHEMA,
                            cancel_check=lambda: cancelled["flag"])

    assert runs == ["read_file"]
    assert len([e for e in events if isinstance(e, ToolCallResult)]) == 1
    assert isinstance(events[-1], Done) and events[-1].cancelled
    assert backend.calls == 1           # no follow-up round
    assert messages[-1]["content"].startswith("[Cancelled by user]")
    _assert_tool_calls_answered(messages)


def test_cancel_while_waiting_for_approval_does_not_run_tool(tool_runs):
    cancelled = {"flag": False}

    def approve(name, args):
        cancelled["flag"] = True        # Esc pressed while the modal was open
        return True

    backend = FakeBackend([[tool_call({"name": "read_file", "args": {"path": "a"}})]])
    events, messages = _run(backend, tools_schema=SCHEMA, approve_fn=approve,
                            cancel_check=lambda: cancelled["flag"])

    assert tool_runs == []
    assert isinstance(events[-1], Done) and events[-1].cancelled
    _assert_tool_calls_answered(messages)


def test_cancel_between_rounds_skips_follow_up_request(monkeypatch):
    cancelled = {"flag": False}

    def run_tool(name, **kwargs):
        cancelled["flag"] = True
        return "ok"

    monkeypatch.setattr("aihub_code.engine.chat.run_tool", run_tool)
    backend = FakeBackend([
        [tool_call({"name": "read_file", "args": {"path": "a"}})],
        [text("never requested")],
    ])
    events, messages = _run(backend, tools_schema=SCHEMA,
                            cancel_check=lambda: cancelled["flag"])

    assert backend.calls == 1
    assert isinstance(events[-1], Done) and events[-1].cancelled
    assert messages[-1]["role"] == "tool" and messages[-1]["content"] == "ok"
    _assert_tool_calls_answered(messages)


def test_tool_round_then_answer_without_cancel(tool_runs):
    backend = FakeBackend([
        [tool_call({"name": "read_file", "args": {"path": "a"}})],
        [text("done")],
    ])
    events, messages = _run(backend, tools_schema=SCHEMA)

    assert tool_runs == [("read_file", {"path": "a"})]
    assert [type(e).__name__ for e in events if isinstance(e, Done)] == ["Done"]
    assert events[-1] == Done(final_text="done")
    assert backend.closed == 2
    _assert_tool_calls_answered(messages)


def test_stream_closed_when_consumer_stops_early():
    """Closing the engine generator (bridge cancel path) must close the
    backend stream too."""
    backend = FakeBackend([[text("a"), text("b"), text("c")]])
    gen = run_chat_turn("m", [{"role": "user", "content": "hi"}], stream_fn=backend)
    next(gen)
    gen.close()
    assert backend.closed == 1


def test_tool_runner_replaces_run_tool(tool_runs):
    backend = FakeBackend([
        [tool_call({"name": "read_file", "args": {"path": "a"}})],
        [text("ok")],
    ])
    events, _ = _run(backend, tools_schema=SCHEMA, tool_runner=lambda n, a: "custom")

    assert tool_runs == []
    [res] = [e for e in events if isinstance(e, ToolCallResult)]
    assert res.result == "custom"


def test_before_round_called_each_round(tool_runs):
    backend = FakeBackend([
        [tool_call({"name": "read_file", "args": {"path": "a"}})],
        [text("ok")],
    ])
    calls = []
    _run(backend, tools_schema=SCHEMA, before_round=lambda msgs, i: calls.append(i))

    assert calls == [0, 1]


def test_approve_string_is_denial_text(tool_runs):
    backend = FakeBackend([
        [tool_call({"name": "read_file", "args": {"path": "a"}})],
        [text("ok")],
    ])
    events, messages = _run(backend, tools_schema=SCHEMA,
                            approve_fn=lambda n, a: "Plan mode: present a plan")

    [res] = [e for e in events if isinstance(e, ToolCallResult)]
    assert res.result == "Plan mode: present a plan"
    assert res.denied is True
    assert tool_runs == []
    _assert_tool_calls_answered(messages)


def test_round_limit_not_fatal(tool_runs):
    call = [tool_call({"name": "read_file", "args": {"path": "a"}})]
    backend = FakeBackend([call, call])
    events, messages = _run(backend, tools_schema=SCHEMA, max_tool_rounds=2,
                            round_limit_fatal=False)

    assert isinstance(events[-1], Done) and not events[-1].cancelled
    assert "[Stopped after 2 tool rounds" in events[-1].final_text
    assert not any(isinstance(e, Error) for e in events)
    _assert_tool_calls_answered(messages)


def test_round_limit_fatal_by_default(tool_runs):
    call = [tool_call({"name": "read_file", "args": {"path": "a"}})]
    events, _ = _run(FakeBackend([call, call]), tools_schema=SCHEMA, max_tool_rounds=2)

    assert isinstance(events[-1], Error) and events[-1].fatal
