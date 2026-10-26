"""The installers: a launcher named aihub-code, in its own directory, that can
update and uninstall itself and never touches AIhub's own install or a folder
that isn't an aihub-code install."""
import io
import os
import shutil
import subprocess
import tarfile

import pytest

ROOT = os.path.dirname(os.path.dirname(__file__))


def _read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()


def test_install_sh_writes_the_aihub_code_launcher():
    sh = _read("install.sh")
    assert "$HOME/.local/share/aihub-code" in sh
    assert '"$BIN_DIR/aihub-code"' in sh
    assert 'exec "\\$AIHUB_CODE_HOME/.venv/bin/aihub-code"' in sh
    assert "update)" in sh and "uninstall)" in sh


def test_install_sh_leaves_aihub_alone():
    sh = _read("install.sh")
    # Its own launcher and directory only: AIhub's launcher and install stay.
    assert '"$BIN_DIR/aihub"' not in sh and ".local/share/aihub\"" not in sh
    assert "rm -rf \"$HOME/.aihub\"" not in sh


def test_install_ps1_writes_the_aihub_code_launcher():
    ps = _read("install.ps1")
    assert 'aihub-code.cmd' in ps and 'Join-Path $env:LOCALAPPDATA "AIhubCode"' in ps
    assert r'.venv\Scripts\aihub-code.exe' in ps
    assert '"%~1"=="update"' in ps


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash missing")
def test_install_sh_is_valid_bash():
    r = subprocess.run(["bash", "-n", os.path.join(ROOT, "install.sh")], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_pyproject_pins_the_released_engine():
    toml = _read("pyproject.toml")
    assert "aihub @ git+https://github.com/marceljurgiel/AIhub-TUI@v1.5.0" in toml
    assert 'aihub-code = "aihub_code.cli:app"' in toml


# ── behaviour of install.sh (bash, throwaway HOME, nothing downloaded) ────────

bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash missing")


def _source_tarball(tmp_path):
    p = tmp_path / "src.tar.gz"
    with tarfile.open(p, "w:gz") as t:
        for name, data in (("aihub-code-main/pyproject.toml", b'[project]\nname = "aihub-code"\nversion = "0.0.0"\n'),
                           ("aihub-code-main/aihub_code/__init__.py", b"")):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return str(p)


def _env(tmp_path, **extra):
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home), **extra}
    for k in ("AIHUB_CODE_HOME", "AIHUB_CODE_REF"):
        env.pop(k, None)
    return env


def _install(tmp_path, target):
    return subprocess.run(["bash", os.path.join(ROOT, "install.sh"), "--dir", str(target)],
                          env=_env(tmp_path, AIHUB_CODE_SOURCE=_source_tarball(tmp_path)),
                          capture_output=True, text=True, timeout=60)


@bash
def test_install_refuses_an_existing_folder_that_is_not_an_install(tmp_path):
    target = tmp_path / "tools"
    target.mkdir()
    (target / "keep.txt").write_text("mine")
    (target / ".venv").mkdir()          # somebody else's venv is not ours either
    r = _install(tmp_path, target)
    assert r.returncode != 0
    assert "not an aihub-code install" in r.stderr and "new or empty directory" in r.stderr
    assert (target / "keep.txt").read_text() == "mine" and (target / ".venv").is_dir()


@bash
def test_install_refuses_a_file_as_install_dir(tmp_path):
    target = tmp_path / "afile"
    target.write_text("x")
    assert _install(tmp_path, target).returncode != 0
    assert target.read_text() == "x"


def _run_functions(tmp_path, script):
    """Run bash with install.sh's functions loaded but main not started."""
    return subprocess.run(
        ["bash", "-c", f'AIHUB_CODE_SOURCED=1; . "{os.path.join(ROOT, "install.sh")}"; {script}'],
        env=_env(tmp_path), capture_output=True, text=True, timeout=60)


@bash
@pytest.mark.parametrize("make,ok", [
    (lambda d: None, True),                                                     # empty: usable
    (lambda d: (d / "pyproject.toml").write_text('[project]\nname = "aihub-code"\n'), True),
    (lambda d: (d / "pyproject.toml").write_text('[project]\nname = "other"\n'), False),
    (lambda d: (d / "x.txt").write_text("x"), False),
])
def test_install_dir_check(tmp_path, make, ok):
    d = tmp_path / "d"
    d.mkdir()
    make(d)
    r = _run_functions(tmp_path, f'check_install_dir "{d}"')
    assert (r.returncode == 0) is ok, r.stderr


@bash
def test_install_dir_check_accepts_a_venv_with_the_launcher(tmp_path):
    d = tmp_path / "d"
    (d / ".venv" / "bin").mkdir(parents=True)
    (d / ".venv" / "bin" / "aihub-code").write_text("")
    (d / ".venv" / "bin" / "aihub-code").chmod(0o755)
    assert _run_functions(tmp_path, f'check_install_dir "{d}"').returncode == 0


def _launcher(tmp_path, home_dir):
    r = _run_functions(tmp_path, f'HOME_DIR="{home_dir}"; install_launcher')
    assert r.returncode == 0, r.stderr
    return os.path.join(tmp_path, "home", ".local", "bin", "aihub-code")


@bash
def test_launcher_uninstall_refuses_a_folder_that_is_not_an_install(tmp_path):
    target = tmp_path / "tools"
    target.mkdir()
    (target / "keep.txt").write_text("mine")
    launcher = _launcher(tmp_path, target)
    r = subprocess.run(["sh", launcher, "uninstall"], input="y\n", env=_env(tmp_path),
                       capture_output=True, text=True, timeout=30)
    assert r.returncode != 0 and "not an aihub-code install" in r.stderr
    assert (target / "keep.txt").exists()


@bash
def test_launcher_uninstall_removes_a_real_install(tmp_path):
    target = tmp_path / "inst"
    target.mkdir()
    (target / "pyproject.toml").write_text('[project]\nname = "aihub-code"\n')
    launcher = _launcher(tmp_path, target)
    r = subprocess.run(["sh", launcher, "uninstall"], input="y\n", env=_env(tmp_path),
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0 and not target.exists() and not os.path.exists(launcher)


def test_launcher_update_falls_back_to_wget_and_fails_loudly():
    sh = _read("install.sh")
    assert "wget" in sh.split("LAUNCHER")[1]            # inside the launcher text
    assert "| bash" not in sh.split("LAUNCHER")[1]       # a failed download must not look like success


# ── install.ps1 (text checks only; PowerShell is not available in CI here) ────

def test_install_ps1_checks_the_install_dir_and_the_archive():
    ps = _read("install.ps1")
    assert "not an aihub-code install" in ps and "new or empty directory" in ps
    assert r'.venv\Scripts\aihub-code.exe' in ps
    assert 'Join-Path $src.FullName "aihub_code"' in ps


def test_install_ps1_launcher_update_and_uninstall():
    ps = _read("install.ps1")
    assert 'goto :update' in ps and ':update' in ps and 'exit /b 1' in ps
    assert '"%~1"=="uninstall"' in ps and ':uninstall' in ps


def test_install_ps1_failure_gives_a_nonzero_exit():
    ps = _read("install.ps1")
    assert "exit 1" in ps.split("} catch {")[1]
