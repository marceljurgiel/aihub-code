"""The `aihub-code` command.

`aihub-code -p "task"` runs one coding turn in the current folder and exits
(see headless.py for the exit codes). The interactive UI is not built yet.
"""
from __future__ import annotations

from typing import List, Optional

import typer

from . import __version__

app = typer.Typer(add_completion=False, no_args_is_help=False, pretty_exceptions_enable=False,
                  help="A coding agent for local and cloud models, on AIhub's engine.")

INTERACTIVE_SOON = ('The interactive aihub-code UI is coming in a later version — '
                    'for now use: aihub-code -p "your task"')


def _version(value: bool) -> None:
    if value:
        typer.echo(f"aihub-code {__version__}")
        raise typer.Exit()


@app.command()
def main(
    prompt: Optional[str] = typer.Option(None, "-p", "--prompt", help="Run this coding task in the current folder and exit"),
    mode: str = typer.Option("build", "--mode", help="plan, build or auto"),
    model: Optional[str] = typer.Option(None, "--model", help="Model to use (default: your AIhub default chat model)"),
    output: str = typer.Option("text", "--output", help="text or json"),
    mcp: Optional[List[str]] = typer.Option(None, "--mcp", help="Allow this MCP server (repeatable)"),
    kb: Optional[List[str]] = typer.Option(None, "--kb", help="Search this knowledge base (repeatable)"),
    version: bool = typer.Option(False, "--version", callback=_version, is_eager=True,
                                 help="Show the version and exit"),
):
    """Run a coding task in this folder: aihub-code -p "your task"."""
    if not prompt:
        typer.echo(INTERACTIVE_SOON, err=True)
        raise typer.Exit(2)
    from .headless import run_headless
    raise typer.Exit(run_headless(prompt, mode=mode, model=model, output=output,
                                  mcp=list(mcp or []), knowledge=list(kb or [])))


if __name__ == "__main__":
    app()
