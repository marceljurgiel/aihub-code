"""The installers: a launcher named aihub-code, in its own directory, that can
update and uninstall itself and never touches AIhub's own install."""
import os
import shutil
import subprocess

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
