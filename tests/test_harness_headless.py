import io
import json
import os
import shutil
import subprocess
import threading

import pytest
from typer.testing import CliRunner

from .conftest import FakeBackend, text, tool_call

from aihub_code.engine.filelock import LockBusy, try_file_lock
from aihub_code import headless
from aihub_code.headless import run_headless
from aihub_code.project import store_dir
from aihub.tools import workdir as wd

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git missing")

JSON_KEYS = {"ok", "text", "model", "mode", "session", "files_changed", "denied",
             "todos", "rounds", "usage", "exit_code"}


@pytest.fixture
def proj(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", wd._session_dir)
    monkeypatch.setattr("aihub.agents.agent_context", lambda *a, **k: (8192, "test"))
    root = tmp_path / "proj"
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    (root / "a.txt").write_bytes(b"one\nold\n")
    return root


def _edit():
    return tool_call({"name": "edit_file", "args": {"path": "a.txt", "old": "old", "new": "new"}})


def _go(proj, backend, **kw):
    out, err = io.StringIO(), io.StringIO()
    code = run_headless("change it", cwd=str(proj), model="m", stdout=out, stderr=err,
                        stream_fn=backend, **kw)
    return code, out.getvalue(), err.getvalue()


def test_text_output_and_exit_0(proj):
    code, out, _ = _go(proj, FakeBackend([[text("done")]]))
    assert (code, out) == (0, "done\n")


def test_json_shape(proj):
    code, out, err = _go(proj, FakeBackend([[_edit()], [text("fixed")]]), mode="auto", output="json")
    data = json.loads(out)
    assert set(data) == JSON_KEYS
    assert code == 0 and data["exit_code"] == 0 and data["ok"] is True
    assert data["files_changed"] == ["a.txt"]
    assert data["text"] == "fixed" and data["mode"] == "auto" and data["model"] == "m"
    assert data["session"] and data["rounds"] >= 2 and data["denied"] == 0
    assert "edit_file" in err
    assert (proj / "a.txt").read_bytes() == b"one\nnew\n"


def test_build_mode_denies_and_counts(proj):
    code, out, err = _go(proj, FakeBackend([[_edit()], [text("could not")]]), output="json")
    data = json.loads(out)
    assert data["denied"] == 1 and code == 0
    assert (proj / "a.txt").read_bytes() == b"one\nold\n"
    assert "refused edit_file" in err


def test_round_limit_exit_3(proj, monkeypatch):
    monkeypatch.setattr("aihub_code.session._Hooks.max_tool_rounds", 2)
    rounds = [[tool_call({"name": "list_files", "args": {"path": "."}})] for _ in range(5)]
    code, out, _ = _go(proj, FakeBackend(rounds))
    assert code == 3 and "[Stopped after" in out


def test_backend_error_exit_1(proj):
    def boom(*a, **k):
        raise RuntimeError("backend exploded")
    code, out, err = _go(proj, boom, output="json")
    data = json.loads(out)
    assert code == 1 and data["ok"] is False and data["exit_code"] == 1
    assert data["text"] and err.strip()


def test_ollama_offline_exit_2(proj, monkeypatch):
    monkeypatch.setattr("aihub.ollama_client.is_ollama_running", lambda: False)
    code, out, err = _go(proj, None, output="json")
    data = json.loads(out)
    assert code == 2 and set(data) == JSON_KEYS and data["ok"] is False
    assert "Ollama" in err and data["text"] == err.strip()


def test_missing_model_exit_2(proj, monkeypatch):
    monkeypatch.setattr("aihub.ollama_client.is_ollama_running", lambda: True)
    monkeypatch.setattr("aihub.ollama_client.get_local_models", lambda: ["other"])
    code, _, err = _go(proj, None)
    assert code == 2 and "not installed" in err


def test_bad_mode_exit_2(proj):
    code, out, err = _go(proj, FakeBackend([]), mode="yolo", output="json")
    assert code == 2 and json.loads(out)["exit_code"] == 2 and "mode" in err


def test_bad_output_exit_2(proj):
    code, out, err = _go(proj, FakeBackend([]), output="xml")
    assert code == 2 and out == "" and "output" in err


def test_busy_project_exit_2(proj):
    from aihub_code.project import find_root
    root, _ = find_root(str(proj))
    path = os.path.join(store_dir(root), "session.lock")
    with try_file_lock(path):
        with pytest.raises(LockBusy):          # a second flock on a new fd conflicts
            with try_file_lock(path):
                pass
        code, out, err = _go(proj, FakeBackend([[text("x")]]), output="json")
    assert code == 2 and set(json.loads(out)) == JSON_KEYS
    assert "Another aihub-code session is working in this project." in err
    code, out, _ = _go(proj, FakeBackend([[text("x")]]))      # released afterwards
    assert code == 0


def test_cancel_mid_turn_ends_cleanly(proj, monkeypatch):
    real = headless.run_turn
    def cancelling(session, task, **kw):
        kw["cancel"].set()
        return real(session, task, **kw)
    monkeypatch.setattr(headless, "run_turn", cancelling)
    code, _, _ = _go(proj, FakeBackend([[text("never")] for _ in range(3)]))
    assert code == 130


def test_keyboard_interrupt_cancels_and_exits_130(proj, monkeypatch):
    seen = {}
    real = headless.run_turn
    def slow(session, task, **kw):
        seen["cancel"] = kw["cancel"]
        kw["cancel"].wait(5)
        return real(session, task, **kw)
    monkeypatch.setattr(headless, "run_turn", slow)
    orig_join = threading.Thread.join
    state = {"n": 0}
    def join(self, timeout=None):
        if self.name != threading.current_thread().name and state["n"] == 0 and self.daemon:
            state["n"] = 1
            raise KeyboardInterrupt
        return orig_join(self, timeout)
    monkeypatch.setattr(threading.Thread, "join", join)
    code, _, err = _go(proj, FakeBackend([[text("x")] for _ in range(3)]))
    assert code == 130 and seen["cancel"].is_set() and "Interrupted" in err


def test_progress_lines_fall_back_to_ascii():
    class Narrow(io.StringIO):
        encoding = "ascii"
    s = Narrow()
    headless._progress(s, "→", "->", "read_file a.txt")
    headless._progress(s, "✗", "x", "refused edit_file")
    assert s.getvalue() == "-> read_file a.txt\nx refused edit_file\n"


def test_short_args_picks_first_key_and_truncates():
    assert headless._short_args({"command": "x" * 100}) == "x" * 60
    assert headless._short_args({"path": "a", "command": "b"}) == "a"
    assert headless._short_args(None) == ""


def test_cli_without_prompt_exit_2():
    from aihub_code.cli import app
    r = CliRunner().invoke(app, [])
    assert r.exit_code == 2
    assert "aihub-code -p" in r.output


def test_cli_passes_options(monkeypatch):
    from aihub_code.cli import app
    got = {}
    monkeypatch.setattr("aihub_code.headless.run_headless",
                        lambda task, **kw: got.update(task=task, **kw) or 0)
    r = CliRunner().invoke(app, ["-p", "hi", "--mode", "auto", "--mcp", "a", "--kb", "k", "--output", "json"])
    assert r.exit_code == 0
    assert got["task"] == "hi" and got["mode"] == "auto" and got["mcp"] == ["a"] and got["knowledge"] == ["k"]


def _offline_ok(monkeypatch, names):
    monkeypatch.setattr("aihub.ollama_client.is_ollama_running", lambda: True)
    monkeypatch.setattr("aihub.ollama_client.get_local_models", lambda: names)
    monkeypatch.setattr("aihub_code.backends.resolve_stream_fn", lambda *a: FakeBackend([[text("hi")]]))


def test_bare_model_name_matches_latest(proj, monkeypatch):
    _offline_ok(monkeypatch, ["llama3.2:latest"])
    out, err = io.StringIO(), io.StringIO()
    code = run_headless("t", cwd=str(proj), model="llama3.2", stdout=out, stderr=err)
    assert code == 0 and out.getvalue() == "hi\n"


def test_tagged_model_needs_exact_match(proj, monkeypatch):
    _offline_ok(monkeypatch, ["llama3.2:latest"])
    err = io.StringIO()
    code = run_headless("t", cwd=str(proj), model="llama3.2:1b", stdout=io.StringIO(), stderr=err)
    err = err.getvalue()
    assert code == 2 and "not installed" in err


def test_empty_model_list_message(proj, monkeypatch):
    _offline_ok(monkeypatch, [])
    code, _, err = _go(proj, None)
    assert code == 2 and "Could not list the models" in err


def test_worker_exception_exit_1_one_json_object(proj, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("kaboom")
    monkeypatch.setattr(headless, "run_turn", boom)
    code, out, err = _go(proj, FakeBackend([]), output="json")
    data = json.loads(out)
    assert code == 1 and data["exit_code"] == 1 and "kaboom" in data["text"] and "kaboom" in err


def test_unencodable_answer_does_not_crash(proj):
    buf = io.BytesIO()
    out = io.TextIOWrapper(buf, encoding="cp1252", newline="")
    err = io.StringIO()
    code = run_headless("t", cwd=str(proj), model="m", stdout=out, stderr=err,
                        stream_fn=FakeBackend([[text("go \u2192 ok \u2713")]]))
    out.flush()
    assert code == 0 and buf.getvalue().startswith(b"go ")


def test_broken_pipe_keeps_exit_code(proj):
    class Pipe(io.StringIO):
        def write(self, s):
            raise BrokenPipeError
    code = run_headless("t", cwd=str(proj), model="m", stdout=Pipe(), stderr=io.StringIO(),
                        stream_fn=FakeBackend([[text("x")]]))
    assert code == 0


@pytest.mark.skipif(os.name == "nt", reason="POSIX signals")
def test_sigterm_kills_shells_cancels_and_restores_handlers(proj, monkeypatch):
    import signal
    import time
    got = []
    previous = lambda *a: got.append("previous handler")      # noqa: E731
    old_term = signal.signal(signal.SIGTERM, previous)
    old_hup = signal.getsignal(signal.SIGHUP)
    killed = []
    monkeypatch.setattr("aihub_code.shell.kill_all", lambda: killed.append(True))

    def backend(model, messages, temperature, context_length=None, tools=None):
        def gen():
            os.kill(os.getpid(), signal.SIGTERM)    # `kill <pid>` while the model streams
            time.sleep(0.5)
            yield text("never seen")
        return gen()

    try:
        code, _, err = _go(proj, backend)
        assert code == 130 and killed and "previous handler" not in got
        assert signal.getsignal(signal.SIGTERM) is previous
        assert signal.getsignal(signal.SIGHUP) == old_hup
    finally:
        signal.signal(signal.SIGTERM, old_term)


def test_build_mode_refusal_prints_one_hint(proj):
    code, _, err = _go(proj, FakeBackend([[_edit(), _edit()], [text("could not")]]))
    hint = ("Some actions were refused: nobody can approve them in a -p run. "
            "Use --mode auto, or add project rules.")
    assert code == 0 and err.count(hint) == 1


def test_no_hint_without_refusals(proj):
    _, _, err = _go(proj, FakeBackend([[text("done")]]))
    assert "were refused" not in err


def test_mcp_names_normalised(proj, monkeypatch):
    seen = {}
    real = headless.CodeSession.start

    def start(cwd, model, **kw):
        s = real(cwd, model, **kw)
        seen["mcp"] = list(s.mcp)
        return s
    monkeypatch.setattr(headless.CodeSession, "start", start)
    _go(proj, FakeBackend([[text("done")]]), mcp=["github", "mcp:gmail", "github"])
    assert seen["mcp"] == ["mcp:github", "mcp:gmail"]
