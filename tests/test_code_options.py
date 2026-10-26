"""code.options: MCP and knowledge bases of a running code session."""
from __future__ import annotations

import shutil
import subprocess

import pytest

from aihub_code import bridge, session as hs
from aihub_code.engine.turn import TurnOutcome
from aihub_code.session import CodeSession

from .conftest import FakeBackend, text
from .test_harness_session import _run

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git missing")


@pytest.fixture
def started(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    monkeypatch.setattr("aihub.agents.agent_context", lambda *a, **k: (8192, "test"))
    s = CodeSession.start(str(root), "m")
    monkeypatch.setattr(bridge, "_code", s)
    monkeypatch.setattr(bridge, "_code_busy", False)
    return s


def test_options_apply_from_next_turn(started, monkeypatch):
    demo = {"type": "function", "function": {"name": "demo__search", "parameters": {}}}
    monkeypatch.setattr("aihub_code.tools.schemas_for_agent",
                        lambda entries: [demo] if "mcp:demo" in entries else [])
    monkeypatch.setattr("aihub.mcp_client.enabled_servers", lambda: {"demo": {}})
    monkeypatch.setattr("aihub.knowledge.names", lambda: ["docs"])
    assert bridge._h_code_options({"mcp": True, "knowledge": ["docs"]}) == \
        {"mcp": True, "knowledge": ["docs"]}
    h = started.hooks(emit=lambda *a: None, stream_fn=FakeBackend([]), cancel_check=lambda: False)
    names = [t["function"]["name"] for t in h.tools_schema()]
    assert "demo__search" in names
    assert h._offered("search_knowledge")
    seen = {}

    def fake_drive(p, *, emit, ask, cancel, stream_fn, hooks):
        seen.update(p)
        out = TurnOutcome(p["messages"], False)
        hooks.finish(out)
        return out

    monkeypatch.setattr(hs, "drive_turn", fake_drive)
    _run(started, FakeBackend([[text("hi")]]))
    assert seen["knowledge"] == ["docs"]
    assert bridge._h_code_options({"mcp": False}) == {"mcp": False, "knowledge": ["docs"]}
    assert started.mcp == []


def test_unknown_kb_dropped(started, monkeypatch):
    monkeypatch.setattr("aihub.knowledge.names", lambda: ["docs"])
    assert bridge._h_code_options({"knowledge": ["nope", "docs"]}) == {"mcp": False, "knowledge": ["docs"]}


def test_options_need_session(monkeypatch):
    monkeypatch.setattr(bridge, "_code", None)
    with pytest.raises(bridge._CodeError, match="no code session"):
        bridge._h_code_options({"mcp": True})
