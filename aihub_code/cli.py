"""The `aihub-code` command.

`aihub-code -p "task"` runs one coding turn in the current folder and exits
(see headless.py for the exit codes). Bare `aihub-code` opens the interactive
UI: a Bun/OpenTUI app (app/) that talks to aihub_code.bridge.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

# Output is Unicode (file names, answers, --output json); a Windows console's
# ANSI code page (cp1252) would turn it into "?" without a word.
for _stream in (sys.stdout, sys.stderr):
    try:
        if (_stream.encoding or "").lower().replace("-", "") != "utf8":
            _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

import typer  # noqa: E402
from typer.core import TyperCommand  # noqa: E402

from . import __version__

app = typer.Typer(add_completion=False, no_args_is_help=False, pretty_exceptions_enable=False,
                  help="A coding agent for local and cloud models, on AIhub's engine.")

NO_BUN = ("aihub-code needs Bun for the interactive UI \u2014 install it from https://bun.sh "
          "or re-run the installer; `aihub-code -p` works without it.")


def _find_bun() -> Optional[str]:
    """Bun on PATH, else where its installer puts it."""
    found = shutil.which("bun")
    if found:
        return found
    exe = Path.home() / ".bun" / "bin" / ("bun.exe" if sys.platform == "win32" else "bun")
    return str(exe) if exe.is_file() else None


def _open_interactive(args: dict) -> None:
    """Replace this process with the Bun app; the flags travel as JSON in the env."""
    bun = _find_bun()
    if not bun:
        typer.echo(NO_BUN, err=True)
        raise typer.Exit(2)
    from . import __file__ as pkg_file
    entry = Path(pkg_file).resolve().parent.parent / "app" / "src" / "index.tsx"
    env = dict(os.environ)
    env["AIHUB_CODE_ARGS"] = json.dumps(args)
    env["AIHUB_CODE_BRIDGE"] = json.dumps([sys.executable, "-m", "aihub_code.bridge"])
    argv = [bun, "run", str(entry)]
    if sys.platform == "win32":
        # Windows has no real exec: os.execvpe starts a new process and returns the
        # parent at once, so the shell prompt would come back under the running
        # app. Wait for the child and pass its exit code on instead.
        raise typer.Exit(subprocess.call(argv, env=env))
    os.execvpe(bun, argv, env)


def _version(value: bool) -> None:
    if value:
        typer.echo(f"aihub-code {__version__}")
        raise typer.Exit()


class _OptionalResumeCommand(TyperCommand):
    """Lets `--resume` stand alone: Typer has no optional-value options, so a
    bare `--resume` (last, or followed by another option) gets an empty value."""

    def parse_args(self, ctx, args):
        args = list(args)
        for i, a in enumerate(args):
            if a == "--resume" and (i + 1 == len(args) or args[i + 1].startswith("-")):
                args.insert(i + 1, "")
        return super().parse_args(ctx, args)


@app.command(cls=_OptionalResumeCommand)
def main(
    prompt: Optional[str] = typer.Option(None, "-p", "--prompt", help="Run this coding task in the current folder and exit"),
    mode: Optional[str] = typer.Option(None, "--mode", help="plan, build (default) or auto"),
    model: Optional[str] = typer.Option(None, "--model", help="Model to use (default: your AIhub default chat model)"),
    output: str = typer.Option("text", "--output", help="text or json"),
    mcp: Optional[List[str]] = typer.Option(None, "--mcp", help="Allow this MCP server (repeatable)"),
    kb: Optional[List[str]] = typer.Option(None, "--kb", help="Search this knowledge base (repeatable)"),
    resume: Optional[str] = typer.Option(None, "--resume", metavar="[ID]",
                                         help="Resume a session of this folder: --resume ID, or --resume to pick"),
    cont: bool = typer.Option(False, "--continue", help="Resume this folder's newest session"),
    version: bool = typer.Option(False, "--version", callback=_version, is_eager=True,
                                 help="Show the version and exit"),
):
    """Open the interactive coding UI, or run one task: aihub-code -p "your task"."""
    if not prompt:
        args: dict = {"cont": cont, "mcp": list(mcp or []), "kb": list(kb or [])}
        if model:
            args["model"] = model
        if mode:
            args["mode"] = mode
        if resume is not None:
            args["resume"] = resume or True
        _open_interactive(args)
        return
    from .headless import run_headless
    raise typer.Exit(run_headless(prompt, mode=mode or "build", model=model, output=output,
                                  mcp=list(mcp or []), knowledge=list(kb or [])))


if __name__ == "__main__":
    app()
