"""Shared fakes for the chat engine tests."""
from __future__ import annotations

import os
import tempfile

# Before anything imports aihub: point HOME at a throwaway directory, so the
# engine's ~/.aihub (config.yaml, history, memory) is never the user's real
# one. aihub.config computes its paths from "~" at import time.
# Windows resolves "~" from USERPROFILE, not HOME.
os.environ["HOME"] = os.environ["USERPROFILE"] = tempfile.mkdtemp(prefix="aihub-test-home-")

from typing import Any, Dict, List

import pytest


def text(t: str) -> Dict[str, Any]:
    return {"message": {"content": t}}


def tool_call(*calls: Dict[str, Any]) -> Dict[str, Any]:
    return {"message": {"content": "", "tool_calls": [
        {"function": {"name": c["name"], "arguments": c.get("args", {})}}
        for c in calls
    ]}}


# A tools_schema passed to run_chat_turn switches on tools without going
# through the chat keyword gate.
SCHEMA = [{"type": "function", "function": {"name": "read_file"}}]


class FakeBackend:
    """Scripted stream_fn. `rounds[i]` is the chunk list for the i-th call.

    Records how many chunks the engine actually pulled and how many streams
    were closed, so tests can prove a cancel stops reading from the backend.
    """

    def __init__(self, rounds: List[List[Dict[str, Any]]]) -> None:
        self.rounds = rounds
        self.calls = 0
        self.pulled = 0
        self.closed = 0
        self.tools_seen: list = []

    def __call__(self, model, messages, temperature, context_length=None, tools=None):
        self.tools_seen.append(tools)
        chunks = self.rounds[self.calls]
        self.calls += 1

        def gen():
            try:
                for c in chunks:
                    self.pulled += 1
                    yield c
            finally:
                self.closed += 1

        return gen()


@pytest.fixture
def tool_runs(monkeypatch):
    """Replace real tool execution; returns the list of (name, args) run."""
    runs: List[tuple] = []

    def fake_run_tool(name, **kwargs):
        runs.append((name, kwargs))
        return f"result of {name}"

    monkeypatch.setattr("aihub_code.engine.chat.run_tool", fake_run_tool)
    return runs




@pytest.fixture(autouse=True)
def _never_exec_the_interactive_app(monkeypatch):
    """A bare `aihub-code` replaces the process with Bun: a test that forgets to
    patch os.execvpe would swallow the whole pytest run. Fail loudly instead."""
    def refuse(*args):
        raise AssertionError(f"test tried to exec {args[0]!r}; patch aihub_code.cli.os.execvpe")
    monkeypatch.setattr("aihub_code.cli.os.execvpe", refuse)
