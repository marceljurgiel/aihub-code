import os
import shutil
import subprocess
import threading
import time

import pytest

from aihub_code.shell import run_shell

posix = pytest.mark.skipif(os.name == "nt", reason="POSIX shell syntax")


@posix
def test_exit_code_and_output(tmp_path):
    out = run_shell("echo hi; exit 3", cwd=str(tmp_path))
    assert "hi" in out
    assert out.endswith("[Exit: 3]")


@posix
def test_tail_kept(tmp_path):
    out = run_shell("seq 1 20000", cwd=str(tmp_path), budget=3000)
    assert "20000" in out
    assert "chars omitted" in out
    assert out.startswith("1\n2\n")
    assert out.endswith("[Exit: 0]")


@posix
def test_small_output_not_cut(tmp_path):
    out = run_shell("seq 1 50", cwd=str(tmp_path))
    assert "omitted" not in out and "50" in out


def _alive(marker):
    return subprocess.run(["pgrep", "-f", marker], capture_output=True).stdout.strip()


@posix
@pytest.mark.skipif(shutil.which("pgrep") is None, reason="pgrep missing")
def test_timeout_kills_tree(tmp_path):
    marker = "30.12345"
    t0 = time.time()
    out = run_shell(f"sleep {marker} & sleep {marker}; wait", cwd=str(tmp_path), timeout=1)
    assert out.endswith("[Exit: TIMEOUT]")
    assert time.time() - t0 < 3
    time.sleep(0.2)
    assert not _alive(f"sleep {marker}")


@posix
@pytest.mark.skipif(shutil.which("pgrep") is None, reason="pgrep missing")
def test_cancel_kills_tree(tmp_path):
    marker = "30.54321"
    flag = threading.Event()
    threading.Timer(0.5, flag.set).start()
    t0 = time.time()
    out = run_shell(f"sleep {marker} & sleep {marker}; wait", cwd=str(tmp_path), cancel_check=flag.is_set)
    assert out.endswith("[Exit: CANCELLED]")
    assert time.time() - t0 < 2
    time.sleep(0.2)
    assert not _alive(f"sleep {marker}")


@posix
def test_stdin_closed_no_hang(tmp_path):
    t0 = time.time()
    out = run_shell("read x; echo got:$x", cwd=str(tmp_path), timeout=10)
    assert time.time() - t0 < 5
    assert "TIMEOUT" not in out
    assert out.endswith(("[Exit: 0]", "[Exit: 1]"))


@posix
def test_runs_in_cwd(tmp_path):
    out = run_shell("pwd", cwd=str(tmp_path))
    assert os.path.realpath(str(tmp_path)) in out


@posix
@pytest.mark.skipif(shutil.which("pgrep") is None, reason="pgrep missing")
def test_raising_cancel_check_kills_tree(tmp_path):
    marker = "30.99887"

    def boom():
        raise RuntimeError("cancel check failed")

    with pytest.raises(RuntimeError):
        run_shell(f"sleep {marker} & sleep {marker}; wait", cwd=str(tmp_path), cancel_check=boom)
    time.sleep(0.2)
    assert not _alive(f"sleep {marker}")


@posix
def test_background_grandchild_after_normal_exit_is_fast(tmp_path):
    t0 = time.time()
    out = run_shell("sleep 30.77 & echo done", cwd=str(tmp_path))
    try:
        assert time.time() - t0 < 1.5
        assert "done" in out
        assert "[Background output not captured]" in out
        assert out.endswith("[Exit: 0]")
    finally:
        subprocess.run(["pkill", "-f", "sleep 30.77"], capture_output=True)


@posix
def test_quick_command_returns_fast(tmp_path):
    t0 = time.time()
    run_shell("echo hi", cwd=str(tmp_path))
    assert time.time() - t0 < 1


@posix
def test_split_multibyte_char(tmp_path):
    out = run_shell(r"printf '\342\202'; sleep 0.2; printf '\254'", cwd=str(tmp_path))
    assert "€" in out and "�" not in out


def test_timeout_clamp():
    from aihub_code.shell import _clamp_timeout
    assert _clamp_timeout(0, 900) == 1
    assert _clamp_timeout(-5, 900) == 1
    assert _clamp_timeout(5000, 900) == 900
    assert _clamp_timeout(30, 900) == 30


def _wait_for(cond, seconds=5.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.05)
    return cond()


@posix
@pytest.mark.skipif(shutil.which("pgrep") is None, reason="pgrep missing")
def test_kill_all_ends_running_shells(tmp_path):
    from aihub_code import shell
    marker = "30.24680"
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("r", run_shell(
        f"sleep {marker} & sleep {marker}; wait", cwd=str(tmp_path), timeout=60)), daemon=True)
    t.start()
    assert _wait_for(lambda: _alive(f"sleep {marker}"))
    shell.kill_all()
    t.join(5)
    assert not t.is_alive()
    assert _wait_for(lambda: not _alive(f"sleep {marker}"), 3)
    assert not shell._live


@posix
@pytest.mark.skipif(shutil.which("pgrep") is None, reason="pgrep missing")
def test_bridge_exit_kills_running_shells(tmp_path):
    import sys
    marker = "30.13579"
    code = (
        "import threading, time\n"
        "from aihub_code import shell\n"
        "from aihub_code import bridge\n"
        f"threading.Thread(target=shell.run_shell, args=('sleep {marker}',),\n"
        f"                 kwargs={{'cwd': {str(tmp_path)!r}, 'timeout': 60}}, daemon=True).start()\n"
        "while not shell._live:\n"
        "    time.sleep(0.02)\n"
        "bridge.main()\n"
    )
    try:
        proc = subprocess.run([sys.executable, "-c", code], input="", capture_output=True,
                              text=True, timeout=60)
        assert '"event": "ready"' in proc.stdout
        assert _wait_for(lambda: not _alive(f"sleep {marker}"), 3)
    finally:
        subprocess.run(["pkill", "-f", f"^sleep {marker}"], capture_output=True)
