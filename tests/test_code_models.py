"""Models in a code session: backend, temperature and context reach the engine."""
from __future__ import annotations

import pytest

from aihub import agents
from aihub_code import bridge

from .conftest import text
from .test_code_bridge import call, proj, start, use, wire  # noqa: F401 (fixtures)


_REAL_AGENT_CONTEXT = agents.agent_context


class _Recorder:
    """A stream_fn that records what the engine asked of it."""

    def __init__(self):
        self.temps, self.ctxs = [], []

    def __call__(self, model, messages, temperature, context_length=None, tools=None):
        self.temps.append(temperature)
        self.ctxs.append(context_length)
        return iter([text("ok")])


@pytest.fixture(autouse=True)
def _keep_config(monkeypatch):
    from aihub.config import config
    monkeypatch.setattr(config, "temperature", config.temperature)
    monkeypatch.setattr(config, "context_overrides", dict(config.context_overrides))
    monkeypatch.setattr("aihub.config.save_config", lambda *_a, **_k: None)


def test_code_start_reports_backend_stream_model_and_temperature(wire, proj):  # noqa: F811
    info = start(wire, proj, backend="api", stream_model="https://x/y")
    assert info["backend"] == "api" and info["stream_model"] == "https://x/y"
    from aihub.config import config
    assert info["temperature"] == config.temperature


def test_temperature_set_by_config_set_reaches_the_next_turn(wire, proj, monkeypatch):  # noqa: F811
    start(wire, proj)
    rec = _Recorder()
    use(monkeypatch, rec)
    call(wire, "config.set", {"patch": {"temperature": 0.3}})
    call(wire, "code.turn", {"text": "hi"})
    call(wire, "config.set", {"patch": {"temperature": 1.4}})
    call(wire, "code.turn", {"text": "again"})
    assert rec.temps == [0.3, 1.4]


def test_context_set_by_hand_sizes_the_next_code_start(wire, proj, monkeypatch):  # noqa: F811
    # The real agent_context (the wire fixture fakes it), with a manual size for the model.
    monkeypatch.setattr("aihub.agents.agent_context", _REAL_AGENT_CONTEXT)
    monkeypatch.setattr("aihub.hardware.manual_context", lambda model: 24576 if model == "m" else 0)
    info = start(wire, proj)
    assert info["context_length"] == 24576
