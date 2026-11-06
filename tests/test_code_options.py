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


def test_non_bool_mcp_raises(started):
    for bad in ("yes", 1, [], {}):
        with pytest.raises(bridge._CodeError, match="mcp must be true or false"):
            bridge._h_code_options({"mcp": bad})
    assert started.mcp == []


def test_options_are_saved_at_once(started, monkeypatch):
    monkeypatch.setattr("aihub.knowledge.names", lambda: ["docs"])
    saved = []
    monkeypatch.setattr(type(started.store()), "save", lambda self, s: saved.append(list(s.knowledge)))
    bridge._h_code_options({"knowledge": ["docs"]})
    assert saved == [["docs"]]


def test_saved_options_survive_resume(started, monkeypatch):
    monkeypatch.setattr("aihub.knowledge.names", lambda: ["docs"])
    bridge._h_code_options({"knowledge": ["docs"]})
    again = CodeSession.resume(started.cwd, started.id)
    assert again.knowledge == ["docs"]


def test_info_carries_options(started):
    info = bridge._code_info(started)
    assert info["mcp"] is False and info["knowledge"] == []


def test_options_for_a_session_no_longer_open_are_refused(started, monkeypatch):
    # The app sent them for the session it had; code.start (on its own thread)
    # may have put a new one in place first: that one must not get them.
    monkeypatch.setattr("aihub.knowledge.names", lambda: ["docs"])
    with pytest.raises(bridge._CodeError, match="no longer open"):
        bridge._h_code_options({"knowledge": ["docs"], "session_id": "an-older-one"})
    assert started.knowledge == []
    assert bridge._h_code_options({"knowledge": ["docs"], "session_id": started.id}) == \
        {"mcp": False, "knowledge": ["docs"]}
