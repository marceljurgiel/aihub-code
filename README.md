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
 aihub-code 0.3.0 · gemma4:cloud · build · ~/my-project (main)

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
 gemma4:cloud · cloud · build · ctx 12% · shift+tab mode · /help
```

It is built on the engine of [AIhub](https://github.com/marceljurgiel/AIhub-TUI)
and brings all of AIhub into the CLI: models, agents, skills, memory,
connections (MCP, Google), knowledge bases, scheduled tasks, images and
history, each as a panel above the prompt. It reads and writes the same
`~/.aihub` as AIhub: the Ollama server, your models, agents, memory, MCP
servers, knowledge bases, scheduled tasks and per-model context sizes. The
theme and accent are aihub-code's own (`~/.aihub/aihub-code-settings.json`),
so changing them here does not change AIhub. aihub-code installs AIhub's
released engine as a dependency and never modifies it.

> **Status: early (0.3.0).** Developed and tried on Linux. The Windows and
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
one); it is only offered when there is a rule to store, and without one `2`
does nothing, so `3` is always No. Option 3 lets you type what the model
should do instead. Esc says no. Keys count only after half a second without
typing, so a message you are typing when the question appears can't answer
it.

### Undo

Before each turn aihub-code snapshots the project into a shadow git
repository kept in `~/.aihub/projects/<project>/`, outside your project and
independent of its own `.git`. `/undo` shows which files the last turn
changed and asks before restoring them. It restores or deletes only the
paths that turn changed and warns about files you changed since
(`/undo force` overrides). Shell commands are not reverted.

### Slash commands

Code and session:

| Command | |
|---|---|
| `/help [keys]` | the commands and keys |
| `/mode [plan\|build\|auto]` | show or change the mode |
| `/plan` | switch to plan mode |
| `/undo [force]` | undo the last turn's file changes |
| `/compact` | summarize the conversation to free context |
| `/todos` | show the model's todo list |
| `/rules [remove N]` | list permission rules, or remove one |
| `/sessions` | pick an earlier session of this folder |
| `/resume [id]` | resume an earlier session |
| `/clear`, `/new` | new session on the same model and kind, from a fresh screen |
| `/context` | how much of the context is used |
| `/exit` | leave aihub-code |

AIhub, as panels above the prompt (Esc closes one):

| Command | |
|---|---|
| `/model [name]` | the Models panel; with a name, switch to that model directly (starts a new session) |
| `/models` | installed models, catalogue with hardware fit, downloads, context per model |
| `/hardware` | what this machine and the Ollama server have |
| `/agent [code\|chat\|name]` | choose what you talk to (see below) |
| `/agents` | manage AIhub's agent profiles |
| `/skills`, `/skill <name> [task]` | browse, create and install skills; use one |
| `/memory [save\|clear\|undo]` | edit what AIhub remembers about you |
| `/memoryadd` | extract facts from this chat into memory |
| `/mcp` | connections: Google sign-in, GitHub and other services |
| `/kb [name\|off]` | answer from a knowledge base in this chat; without a name, list them |
| `/knowledge` | knowledge bases: build and search your own documents |
| `/schedule [run <name>]` | scheduled tasks; run one now |
| `/history` | AIhub's saved conversations |
| `/settings` | Ollama server, default model, memory, tools |
| `/theme [name]` | colours: `terminal` (default) uses your terminal's own, or `aihub`, `nord`, ... |
| `/temp [value]` | temperature |
| `/tools` | list the agent tools the engine has |
| `/websearch [query]` | try web search once, as in AIhub 1.5.0 |

Ctrl+P opens a palette of all commands.

To send text that starts with `/`, start it with `//`.

### `/agent`: what you talk to

| Choice | |
|---|---|
| `code` (default) | the coding agent: files, shell, search, modes, approvals, `/undo`, code sessions |
| `chat` | AIhub's plain chat, saved in AIhub's history |
| a profile name | one of AIhub's agent profiles, with its own tools and permissions |

`/agent` alone opens a picker. Switching between `code` and the others
starts a new conversation and prints the resume line of the code session;
`chat` and the agent profiles share one AIhub conversation, so switching
between them carries it on. Shift+Tab cycles the modes under `code`, and
build and plan under a profile that has them. In every kind you have memory
(and it learns new facts after a reply), skills, knowledge bases (`/kb`), MCP
connections (`/mcp`, switched on mid-session), temperature, the per-model
context size and images: type or paste an image path, or press Ctrl+V with an
image in the clipboard, to attach it to the next message. The status line
shows, in this order, the model and where it runs (GPU, CPU, cloud), the kind
and mode, context used, `kb:<n>` (knowledge bases in use), `mcp:on` and a
running task.

Scheduled tasks run in the background while aihub-code is open, and only
then. The shortest interval is 5 minutes, as in AIhub. A task's result is
printed into the scrollback. If a newer Ollama is out, a note at start says
so and prints the update command; there is no update panel and no terminal
panel, since you are already in a terminal.

### Keys

| Key | |
|---|---|
| Enter | send (while a turn runs, the message is queued and sent after it; interrupting the turn drops the queue) |
| Shift+Enter, Ctrl+J | new line in the prompt |
| Up / Down | earlier prompts |
| Tab | complete a slash command |
| Shift+Tab | cycle the mode |
| Esc | interrupt a running turn; otherwise clear the prompt; closes a panel |
| Ctrl+C | interrupt; otherwise clear the prompt; press twice on an empty prompt to exit |
| Ctrl+D | exit (on an empty prompt) |
| Ctrl+P | palette of all commands |
| Ctrl+V | attach the image in the clipboard |
| Backspace | on an empty prompt, removes the last attached image |

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

aihub-code is a coding tool with the whole hub inside; [AIhub](https://github.com/marceljurgiel/AIhub-TUI)
is the full-screen app. Both read and write the same `~/.aihub`, so models,
agents, memory, connections, knowledge bases and scheduled tasks are shared:
set one up in either. Only the theme and accent are separate. aihub-code does
not need AIhub's app installed, only its engine, which the installer brings.

A code session belongs to the folder it was started in (undo, rules and
sessions are kept per folder), so there is no `/cd`: start aihub-code in the
other folder instead.

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
