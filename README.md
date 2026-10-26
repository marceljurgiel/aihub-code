# aihub-code

A Claude-Code-style coding agent for the terminal that runs on **local and
cloud models** through [Ollama](https://ollama.com). Start it in your project
folder and talk to it: it reads your code, edits files, runs commands and
tests, and keeps a checkpoint of every turn so a turn can be undone.

The conversation is printed into your normal terminal, so you can scroll,
select and copy it, and it stays there after you exit. Only a small area at
the bottom is live: the activity line, the permission question, the prompt
box and a status line.

```
 aihub-code 0.2.0 · gemma4:cloud · build · ~/my-project (main)

> fix the failing test in calc.py
● read_file calc.py
  ⎿ 12 lines
● edit_file calc.py
  ⎿ - return a - b
    + return a + b
● run_shell pytest -q
  ⎿ 3 passed  [exit 0]
Fixed: add() subtracted instead of adding.

╭──────────────────────────────────────────────╮
│ >                                            │
╰──────────────────────────────────────────────╯
 build · gemma4:cloud · ctx 12% · shift+tab mode · /help
```

It is built on the engine of [AIhub](https://github.com/marceljurgiel/AIhub-TUI)
(Ollama client, model catalogue, MCP connections, knowledge bases) and reads
the same `~/.aihub` settings: the Ollama server, your models, MCP servers and
per-model context sizes. Set those up once in AIhub; aihub-code uses them.
aihub-code installs AIhub's released engine as a dependency and never
modifies it.

> **Status: early (0.2.0).** Developed and tried on Linux. The Windows and
> macOS installers and the interactive UI have not been tried on a real
> Windows or macOS machine yet. Expect rough edges, and small local models
> sometimes ask instead of acting.

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
named `aihub-code`, and install [Bun](https://bun.sh) (into `~/.bun`) if you
do not have it: Bun runs the interactive UI. No root needed. Run the
installer again, or `aihub-code update`, to update; `aihub-code uninstall`
removes it (your `~/.aihub` stays).

You also need a model: an Ollama server (local or on your network) or Ollama
cloud models, configured in AIhub or in `~/.aihub/config.yaml`
(`ollama_api_url`, `default_chat_model`).

## Quick start

```sh
cd my-project
aihub-code
```

Type a task and press Enter. Watch the tool lines scroll by; when the agent
wants to do something your rules do not cover, it asks. Press Esc to
interrupt a running turn. `/help` lists the commands and keys.

Options of the interactive command:

| Option | |
|---|---|
| `--model NAME` | default: your AIhub default chat model |
| `--mode plan\|build\|auto` | start in this mode (default `build`) |
| `--mcp NAME` | let the agent use this MCP server (repeatable) |
| `--kb NAME` | let the agent search this knowledge base (repeatable) |
| `--resume [ID]` | continue an earlier session of this folder; without an ID, pick one |
| `--continue` | continue this folder's newest session |

If no model is set up yet, the model picker opens first.

### Modes

Shift+Tab cycles build, auto and plan; `/mode` and `/plan` do the same by
name.

- **plan**: read-only. The agent explores and answers with a plan; edits and
  commands are refused.
- **build**: edits and commands are checked against your allow rules;
  anything not covered needs your approval.
- **auto**: no questions, except for dangerous commands (deleting, `git
  clean`, piping into a shell, ...). Auto is **not a sandbox**: use it in
  projects you can restore.

Writes outside the project or into `.git` are asked about in build mode and
refused in auto mode.

### Approvals

In build mode the prompt box is replaced by the question, with a preview of
the change when there is one:

```
╭──────────────────────────────────────────────╮
│ Allow edit_file calc.py?                     │
│ - return a - b                               │
│ + return a + b                               │
│ ❯ 1. Yes                                     │
│   2. Yes, and don't ask again for edit_file  │
│      (this project)                          │
│   3. No, and tell the model what to do       │
│      instead                                 │
╰──────────────────────────────────────────────╯
```

Press `1`, `2` or `3`, or use the arrow keys and Enter. Option 2 stores an
allow rule for the project (`/rules` lists them, `/rules remove N` removes
one). Option 3 lets you type what the model should do instead. Esc says no.

### Undo

Before each turn aihub-code snapshots the project into a shadow git
repository kept in `~/.aihub/projects/<project>/`, outside your project and
independent of its own `.git`. `/undo` shows which files the last turn
changed and asks before restoring them. It restores or deletes only the
paths that turn changed and warns about files you changed since
(`/undo force` overrides). Shell commands are not reverted.

### Slash commands

| Command | |
|---|---|
| `/help` | the commands and keys |
| `/mode [plan\|build\|auto]` | show or change the mode |
| `/plan` | switch to plan mode |
| `/model [name]` | choose a model (starts a new session) |
| `/undo [force]` | undo the last turn's file changes |
| `/compact` | summarize the conversation to free context |
| `/todos` | show the model's todo list |
| `/rules [remove N]` | list permission rules, or remove one |
| `/sessions` | pick an earlier session of this folder |
| `/resume [id]` | resume an earlier session |
| `/clear` | new session on the same model and mode |
| `/context` | how much of the context is used |
| `/exit` | leave aihub-code |
| `/hub` | where models, agents and connections live |

To send text that starts with `/`, start it with `//`.

### Keys

| Key | |
|---|---|
| Enter | send (while a turn runs, the message is queued and sent after it) |
| Shift+Enter, Ctrl+J | new line in the prompt |
| Up / Down | earlier prompts |
| Tab | complete a slash command |
| Shift+Tab | cycle the mode |
| Esc | interrupt a running turn; otherwise clear the prompt |
| Ctrl+C | interrupt; otherwise clear the prompt; press twice on an empty prompt to exit |
| Ctrl+D | exit (on an empty prompt) |

Shift+Enter needs a terminal that supports the kitty keyboard protocol
(kitty, WezTerm, Ghostty, recent iTerm2 and others). In other terminals it
sends the message like Enter; **Ctrl+J always adds a line**.

On exit aihub-code prints `Resume this session: aihub-code --resume <id>`.

### Sessions

Every conversation is saved. `aihub-code --continue` picks up the newest
session of the folder, `aihub-code --resume` lets you choose one, and
`aihub-code --resume <id>` opens a given one. The earlier conversation is
printed again so you can see where you were.

## One task, no UI: `-p`

For scripts and CI:

```sh
aihub-code -p "fix the failing test in calc.py"
aihub-code -p "add a --verbose flag" --mode auto --model gemma4:cloud
aihub-code -p "how is the config loaded?" --mode plan --output json
```

| Option | |
|---|---|
| `-p`, `--prompt` | the task; runs one turn in the current folder and exits |
| `--mode plan\|build\|auto` | as above (default `build`) |
| `--model NAME` | default: your AIhub default chat model |
| `--output text\|json` | `json` prints one object: answer, files changed, refused calls, usage |
| `--mcp NAME`, `--kb NAME` | as above (repeatable) |

There is nobody to ask in a `-p` run, so in build mode the calls that need
approval are refused, and aihub-code says so. `-p` does not need Bun.

Exit codes: 0 done, 1 error, 2 bad input or the project is busy, 3 stopped at
the tool-round limit, 130 interrupted.

### Project instructions

`AGENTS.md`, `CLAUDE.md` or `GEMINI.md` in the project (or a parent folder)
is read into the prompt.

## aihub-code and AIhub

aihub-code is the coding tool; [AIhub](https://github.com/marceljurgiel/AIhub-TUI)
is the hub. The model catalogue and downloads, agents, connections (MCP,
Google) and knowledge bases live in `aihub`, which shares `~/.aihub` with
aihub-code. Configure them there; `/hub` reminds you inside aihub-code.
aihub-code does not need AIhub's app installed, only its engine, which the
installer brings.

## Develop

```sh
uv venv && uv pip install -e '.[dev]'
.venv/bin/python -m pytest -q
cd app && bun install && bun test && bunx tsc --noEmit
```

Tests run with a throwaway home directory and never touch `~/.aihub` or the
network. The deliberate behaviour decisions are in
[docs/RULINGS.md](docs/RULINGS.md).

## License

MIT
