# aihub-code

A Claude-Code-style coding agent for the terminal that runs on **local and
cloud models**. Give it a task in your project folder; it reads your code,
edits files, runs commands and tests, and keeps a checkpoint of every turn so
a turn can be undone.

It is built on the engine of [AIhub](https://github.com/marceljurgiel/AIhub-TUI)
(Ollama client, model catalogue, MCP connections, knowledge bases) and reads
the same `~/.aihub` settings: the Ollama server, your models, MCP servers and
per-model context sizes. Set those up once in AIhub; aihub-code uses them.
aihub-code installs AIhub's released engine as a dependency and never
modifies it.

> **Status: early (0.1.0).** The engine and the headless command work.
> The interactive UI (normal terminal output, prompt and status line at the
> bottom) is coming; until then `aihub-code` runs one task per call with `-p`.

## Install

Linux and macOS (needs `git` and `curl`):

```sh
curl -fsSL https://raw.githubusercontent.com/marceljurgiel/aihub-code/main/install.sh | bash
```

Windows 10/11 (PowerShell, needs `git`):

```powershell
irm https://raw.githubusercontent.com/marceljurgiel/aihub-code/main/install.ps1 | iex
```

Both put aihub-code in its own Python environment (`~/.local/share/aihub-code`
on Linux and macOS, `%LOCALAPPDATA%\AIhubCode` on Windows) with a launcher
named `aihub-code`. No root needed. Run the installer again, or
`aihub-code update`, to update. The Windows installer has not been tried on a
real Windows machine yet.

You also need a model: an Ollama server (local or on your network) or Ollama
cloud models, configured in AIhub or in `~/.aihub/config.yaml`
(`ollama_api_url`, `default_chat_model`).

## Use

In a project folder:

```sh
aihub-code -p "fix the failing test in calc.py"
aihub-code -p "add a --verbose flag" --mode auto --model gemma4:cloud
aihub-code -p "how is the config loaded?" --mode plan
```

| Option | |
|---|---|
| `-p`, `--prompt` | the task; runs one turn in the current folder and exits |
| `--mode plan\|build\|auto` | see below (default `build`) |
| `--model NAME` | default: your AIhub default chat model |
| `--output text\|json` | `json` prints one object: answer, files changed, refused calls, usage |
| `--mcp NAME` | let the agent use this MCP server (repeatable) |
| `--kb NAME` | let the agent search this knowledge base (repeatable) |

Exit codes: 0 done, 1 error, 2 bad input or the project is busy, 3 stopped at
the tool-round limit, 130 interrupted.

### Modes

- **plan**: read-only. The agent explores and answers with a plan; edits and
  commands are refused.
- **build**: edits and commands are checked against your allow rules;
  anything not covered needs approval. A `-p` run has nobody to ask, so those
  calls are refused, and aihub-code says so.
- **auto**: no questions, except for dangerous commands (deleting, `git
  clean`, piping into a shell, ...). Auto is **not a sandbox**: use it in
  projects you can restore.

Writes outside the project or into `.git` are asked about in build mode and
refused in auto mode.

### Undo

Before each turn aihub-code snapshots the project into a shadow git
repository kept in `~/.aihub/projects/<project>/`, outside your project and
independent of its own `.git`. Undoing a turn restores or deletes only the
paths that turn changed and warns about files you changed since. Shell
commands are not reverted. The undo command comes with the interactive UI.

### Project instructions

`AGENTS.md`, `CLAUDE.md` or `GEMINI.md` in the project (or a parent folder)
is read into the prompt.

## Develop

```sh
uv venv && uv pip install -e '.[dev]'
.venv/bin/python -m pytest -q
```

Tests run with a throwaway home directory and never touch `~/.aihub` or the
network. The deliberate behaviour decisions are in
[docs/RULINGS.md](docs/RULINGS.md).

## License

MIT
