"""The command's own surface and the bridge methods served by AIhub's handlers."""
import json
import sys
import types

from typer.testing import CliRunner

from aihub_code import __version__, bridge
from aihub_code.cli import app


def test_cli_version():
    r = CliRunner().invoke(app, ["--version"])
    assert r.exit_code == 0 and r.output.strip() == f"aihub-code {__version__}"


def test_cli_help_names_the_flags():
    out = CliRunner().invoke(app, ["--help"]).output
    for flag in ("--prompt", "--mode", "--model", "--output", "--mcp", "--kb"):
        assert flag in out


def test_bridge_ping_is_its_own(monkeypatch):
    sent = []
    monkeypatch.setattr(bridge, "_send", sent.append)
    bridge._run(1, "ping", {})
    assert sent == [{"id": 1, "done": True, "data": {"version": __version__}}]


def test_bridge_serves_aihubs_handlers_for_config_and_models(monkeypatch):
    fake = types.SimpleNamespace(_ONESHOT={
        "config.get": lambda p: {"cfg": 1},
        "models.installed": lambda p: {"models": []},
        "cloud.models": lambda p: {"models": ["m:cloud"]},
    })
    monkeypatch.setitem(sys.modules, "aihub.bridge", fake)
    monkeypatch.setattr("aihub.bridge", fake, raising=False)
    sent = []
    monkeypatch.setattr(bridge, "_send", sent.append)
    for i, m in enumerate(("config.get", "models.installed", "cloud.models")):
        bridge._run(i, m, {})
    assert [s["data"] for s in sent] == [{"cfg": 1}, {"models": []}, {"models": ["m:cloud"]}]


def test_bridge_unknown_method_is_an_error(monkeypatch):
    sent = []
    monkeypatch.setattr(bridge, "_send", sent.append)
    bridge._run(7, "chat.turn", {})        # AIhub's chat is not served here
    assert sent == [{"id": 7, "error": "unknown method: chat.turn"}]
