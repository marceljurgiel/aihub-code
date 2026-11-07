"""The command's own surface and the bridge methods served by AIhub's handlers."""
import importlib
import io
import re
import sys
import types

from typer.testing import CliRunner

from aihub_code import __version__, bridge
from aihub_code.cli import app


def test_cli_version():
    r = CliRunner().invoke(app, ["--version"])
    assert r.exit_code == 0 and r.output.strip() == f"aihub-code {__version__}"


def test_cli_help_names_the_flags():
    # Typer colours its help when GITHUB_ACTIONS is set (read at import), so
    # on CI the flags come wrapped in colour codes.
    raw = CliRunner().invoke(app, ["--help"], env={"COLUMNS": "200"}).output
    out = re.sub(r"\x1b\[[0-9;]*m", "", raw)
    for flag in ("--prompt", "--mode", "--model", "--output", "--mcp", "--kb", "--resume", "--continue"):
        assert flag in out


def test_bridge_ping_is_its_own(monkeypatch):
    sent = []
    monkeypatch.setattr(bridge, "_send", sent.append)
    bridge._run(1, "ping", {})
    assert sent == [{"id": 1, "done": True, "data": {"version": __version__}}]


def test_bridge_serves_aihubs_handlers_for_config_and_models(monkeypatch):
    fake = types.SimpleNamespace(_STREAMING={}, _ONESHOT={
        "config.get": lambda p: {"cfg": 1},
        "models.installed": lambda p: {"models": []},
        "cloud.models": lambda p: {"models": ["m:cloud"]},
    })
    monkeypatch.setattr(bridge, "_aihub_mod", fake)
    sent = []
    monkeypatch.setattr(bridge, "_send", sent.append)
    for i, m in enumerate(("config.get", "models.installed", "cloud.models")):
        bridge._run(i, m, {})
    assert sent[0]["data"] == {"cfg": 1}
    assert sent[2]["data"] == {"models": ["m:cloud"]}
    # models.installed is AIhub's list plus the machine its fit is rated for
    # (aihub_code.installed_fit).
    assert sent[1]["data"]["models"] == [] and "target" in sent[1]["data"]


def test_bridge_unknown_method_is_an_error(monkeypatch):
    sent = []
    monkeypatch.setattr(bridge, "_send", sent.append)
    bridge._run(7, "no.such.method", {})
    assert sent == [{"id": 7, "error": "unknown method: no.such.method"}]


def test_cli_makes_stdout_and_stderr_utf8(monkeypatch):
    # A Windows console is cp1252: without a reconfigure, --output json turns
    # non-Latin text into "?".
    import aihub_code.cli as cli
    raw_out, raw_err = io.BytesIO(), io.BytesIO()
    # newline="\n": what is checked is the encoding, not Windows' CRLF.
    out = io.TextIOWrapper(raw_out, encoding="cp1252", errors="strict", write_through=True, newline="\n")
    err = io.TextIOWrapper(raw_err, encoding="cp1252", errors="strict", write_through=True, newline="\n")
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "stderr", err)
    try:
        importlib.reload(cli)
        print("\u0142\u015b\u2192", file=sys.stdout)
        print("\u0142\u015b\u2192", file=sys.stderr)
    finally:
        monkeypatch.undo()
        importlib.reload(cli)
    assert raw_out.getvalue() == "\u0142\u015b\u2192\n".encode("utf-8")
    assert raw_err.getvalue() == "\u0142\u015b\u2192\n".encode("utf-8")


# ── bare `aihub-code` opens the interactive app ───────────────────────────────
import json
from pathlib import Path

import aihub_code
import aihub_code.cli as cli_mod


def _patch_launch(monkeypatch, bun="/opt/bun/bin/bun"):
    calls = []
    monkeypatch.setattr(cli_mod, "_find_bun", lambda: bun)
    monkeypatch.setattr(cli_mod.os, "execvpe", lambda *a: calls.append(a))
    # Windows waits for the app as a child process instead of exec'ing it.
    def call(argv, env=None):
        calls.append((argv[0], argv, env))
        return 0
    monkeypatch.setattr(cli_mod.subprocess, "call", call)
    return calls


def test_interactive_execs_bun_with_the_app_and_args(monkeypatch):
    calls = _patch_launch(monkeypatch)
    r = CliRunner().invoke(app, ["--model", "m:cloud", "--mode", "auto", "--resume", "abc",
                                 "--mcp", "git", "--kb", "docs", "--kb", "api"])
    assert r.exit_code == 0
    (file, argv, env), = calls
    app_entry = Path(aihub_code.__file__).resolve().parent.parent / "app" / "src" / "index.tsx"
    assert file == "/opt/bun/bin/bun" and argv == ["/opt/bun/bin/bun", "run", str(app_entry)]
    args = json.loads(env["AIHUB_CODE_ARGS"])
    assert args == {"model": "m:cloud", "mode": "auto", "resume": "abc", "cont": False,
                    "mcp": ["git"], "kb": ["docs", "api"]}
    assert json.loads(env["AIHUB_CODE_BRIDGE"]) == [sys.executable, "-m", "aihub_code.bridge"]


def test_interactive_defaults_send_no_model_or_resume(monkeypatch):
    calls = _patch_launch(monkeypatch)
    assert CliRunner().invoke(app, []).exit_code == 0
    args = json.loads(calls[0][2]["AIHUB_CODE_ARGS"])
    assert args == {"cont": False, "mcp": [], "kb": []}


def test_resume_without_an_id_and_continue(monkeypatch):
    calls = _patch_launch(monkeypatch)
    assert CliRunner().invoke(app, ["--resume"]).exit_code == 0
    assert json.loads(calls[0][2]["AIHUB_CODE_ARGS"])["resume"] is True
    calls.clear()
    assert CliRunner().invoke(app, ["--continue"]).exit_code == 0
    assert json.loads(calls[0][2]["AIHUB_CODE_ARGS"])["cont"] is True


def test_resume_followed_by_another_flag_is_still_a_bare_resume(monkeypatch):
    calls = _patch_launch(monkeypatch)
    assert CliRunner().invoke(app, ["--resume", "--mode", "plan"]).exit_code == 0
    args = json.loads(calls[0][2]["AIHUB_CODE_ARGS"])
    assert args["resume"] is True and args["mode"] == "plan"


def test_missing_bun_is_exit_2_with_the_message(monkeypatch):
    calls = _patch_launch(monkeypatch, bun=None)
    r = CliRunner().invoke(app, [])
    assert r.exit_code == 2 and calls == []
    assert ("aihub-code needs Bun for the interactive UI — install it from https://bun.sh "
            "or re-run the installer; `aihub-code -p` works without it.") in r.output


def test_find_bun_prefers_path_then_the_bun_install_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(cli_mod.shutil, "which", lambda n: "/usr/bin/bun")
    assert cli_mod._find_bun() == "/usr/bin/bun"
    monkeypatch.setattr(cli_mod.shutil, "which", lambda n: None)
    monkeypatch.setattr(cli_mod.Path, "home", classmethod(lambda c: tmp_path))
    assert cli_mod._find_bun() is None
    exe = tmp_path / ".bun" / "bin" / ("bun.exe" if sys.platform == "win32" else "bun")
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    assert cli_mod._find_bun() == str(exe)


def test_headless_still_runs_with_p(monkeypatch):
    seen = {}
    import aihub_code.headless as headless
    monkeypatch.setattr(headless, "run_headless", lambda prompt, **kw: seen.update(prompt=prompt, **kw) or 0)
    calls = _patch_launch(monkeypatch)
    r = CliRunner().invoke(app, ["-p", "fix it"])
    assert r.exit_code == 0 and calls == []
    assert seen["prompt"] == "fix it" and seen["mode"] == "build"


def test_resume_equals_form_and_space_form_agree(monkeypatch):
    calls = _patch_launch(monkeypatch)
    for argv in (["--resume=abc"], ["--resume", "abc"]):
        calls.clear()
        assert CliRunner().invoke(app, argv).exit_code == 0
        assert json.loads(calls[0][2]["AIHUB_CODE_ARGS"])["resume"] == "abc"


def test_windows_runs_bun_as_a_child_and_returns_its_exit_code(monkeypatch):
    # os.execvpe on Windows spawns a new process and returns the parent at once,
    # so the shell prompt would come back while the app still owns the console.
    monkeypatch.setattr(sys, "platform", "win32")
    execs, children = _patch_launch(monkeypatch), []
    monkeypatch.setattr(cli_mod.subprocess, "call",
                        lambda argv, env=None: children.append((argv, env)) or 5)
    r = CliRunner().invoke(app, ["--model", "m"])
    assert r.exit_code == 5 and execs == []
    (argv, env), = children
    assert argv[:2] == ["/opt/bun/bin/bun", "run"] and argv[2].endswith("index.tsx")
    assert json.loads(env["AIHUB_CODE_ARGS"])["model"] == "m"
    assert json.loads(env["AIHUB_CODE_BRIDGE"])[1:] == ["-m", "aihub_code.bridge"]


def test_interactive_unknown_mode_is_exit_2_with_the_message(monkeypatch):
    # It used to be dropped on the way to the app: the session started in build.
    calls = _patch_launch(monkeypatch)
    r = CliRunner().invoke(app, ["--mode", "yolo"])
    assert r.exit_code == 2 and calls == []
    assert "unknown mode 'yolo'; use one of plan, build, auto" in r.output
    from aihub_code.permissions import MODES
    assert cli_mod.MODES == MODES


def test_interactive_without_the_app_files_is_exit_2_with_the_message(monkeypatch, tmp_path):
    # A non-editable install has no app/ next to the package: say so instead of
    # Bun's "module not found".
    calls = _patch_launch(monkeypatch)
    monkeypatch.setattr(cli_mod, "_app_entry", lambda: tmp_path / "app" / "src" / "index.tsx")
    r = CliRunner().invoke(app, [])
    assert r.exit_code == 2 and calls == []
    assert "the interactive UI's files are missing" in r.output
    assert "re-run the installer" in r.output
