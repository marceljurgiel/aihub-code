<div align="center">

# aihub-code

**A coding agent in your terminal, on your own models.**

[![CI](https://github.com/marceljurgiel/aihub-code/actions/workflows/ci.yml/badge.svg)](https://github.com/marceljurgiel/aihub-code/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Linux · macOS · Windows](https://img.shields.io/badge/Linux%20·%20macOS%20·%20Windows-supported-blue)

</div>

<p align="center"><img src="docs/media/hero.gif" alt="aihub-code starts in a project, finds the bug behind a failing test, fixes it and runs the tests" width="900"></p>

aihub-code works like Claude Code, but with the models you run yourself through
[Ollama](https://ollama.com): on this computer, on a GPU box on your network,
or Ollama's cloud models. Start it in a project and say what you want. It
reads your code, edits files, runs commands and tests, asks before anything
your rules don't cover, and keeps a checkpoint of every turn so you can undo
it.

The conversation prints into your normal terminal, so you can scroll, select
and copy it, and it stays there after you exit. Only the bottom of the screen
is live: what the agent is doing, its questions, the prompt box and a status
line.

It is built on the engine of [AIhub](https://github.com/marceljurgiel/AIhub-TUI)
and brings the whole hub with it: models, agents, skills, memory, connections,
knowledge bases and scheduled tasks, each a panel above the prompt.

## Install

**Linux / macOS** (needs `git` and `curl`)

```bash
curl -fsSL https://raw.githubusercontent.com/marceljurgiel/aihub-code/main/install.sh | bash
```

**Windows 10 / 11** (PowerShell, needs `git`)

```powershell
irm https://raw.githubusercontent.com/marceljurgiel/aihub-code/main/install.ps1 | iex
```

Then open a new terminal, go to a project and run `aihub-code`.

<p align="center"><img src="docs/media/install.gif" alt="The one-line installer sets up uv, Python, Bun and aihub-code" width="820"></p>

The installer needs no administrator rights and no Python already installed.
It sets up aihub-code in its own Python environment, installs
[Bun](https://bun.sh) (which runs the interactive UI) if you don't have it,
and adds the `aihub-code` command.

You also need a model. If you use [AIhub](https://github.com/marceljurgiel/AIhub-TUI),
aihub-code already knows your Ollama server and models. Otherwise the model
picker opens on the first start, or set `ollama_api_url` and
`default_chat_model` in `~/.aihub/config.yaml`.

To update, run `aihub-code update` or the installer again.

<details>
<summary>Where it installs, and uninstalling</summary>

| Where | Linux / macOS | Windows |
|---|---|---|
| App | `~/.local/share/aihub-code` | `%LOCALAPPDATA%\AIhubCode` |
| Command | `~/.local/bin/aihub-code` | `%LOCALAPPDATA%\AIhubCode\bin\aihub-code.cmd` |
| Settings, sessions, memory | `~/.aihub` | `%USERPROFILE%\.aihub` |

`aihub-code uninstall` removes the app. Your `~/.aihub` stays.
</details>

## What it does

- **Fixes, builds and explains code.** Type a task and watch each step print
  as it happens: files read, edits as diffs, commands with their exit codes.
  Esc interrupts.
  The first time you start it in a folder it asks whether you trust the files
  there, since the agent reads, edits and runs them. It follows the project's
  `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`.

- **Asks before it acts.** In **build** mode (the default) every edit or
  command your rules don't cover waits for you, with a preview of the change.
  Answer "Yes, and don't ask again" once, and that becomes a rule for the
  project (`/rules` lists them).

<p align="center"><img src="docs/media/approvals.gif" alt="aihub-code asks before an edit, the answer becomes a rule, and the next edit goes ahead without asking" width="820"></p>

- **Three modes,** cycled with Shift+Tab:
  - **plan** only reads and answers with a plan; edits and commands are
    refused.
  - **build** asks first, as above.
  - **auto** asks only about dangerous commands, such as deleting files,
    `git clean` or piping into a shell. Auto is **not a sandbox**: use it in
    projects you can restore.

<p align="center"><img src="docs/media/plan.gif" alt="In plan mode aihub-code reads the project and answers with a plan, changing nothing" width="820"></p>

- **Undo** (`/undo`). Before every turn aihub-code snapshots the project into a
  shadow git repository kept outside it, separate from your own `.git`.
  `/undo` shows what the last turn changed and asks before putting it back.
  Shell commands are not reverted.

<p align="center"><img src="docs/media/undo.gif" alt="A fix, then /undo puts the files back and the tests fail again" width="820"></p>

- **All of AIhub, as panels** above the prompt: models ranked for your
  hardware, downloads, agents, skills, memory, connections (Google sign-in,
  GitHub, MCP), knowledge bases, scheduled tasks and history. Esc closes a
  panel; Ctrl+P opens a palette of every command. aihub-code and AIhub share
  `~/.aihub`, so set something up in either and both have it.

<p align="center"><img src="docs/media/hub.gif" alt="The Models panel ranked for this hardware, the agents, memory and the command palette" width="820"></p>

- **Themes** (`/theme`) colour the whole terminal while aihub-code runs, not
  only the text, and put your colours back when it exits. The default,
  `terminal`, keeps your own.

<p align="center"><img src="docs/media/themes.gif" alt="Moving through the themes; the terminal's background follows" width="820"></p>

- **Sessions.** Every conversation is saved per folder. On exit aihub-code
  prints how to resume it; `aihub-code --continue` picks up the newest one
  and shows the conversation again.

<p align="center"><img src="docs/media/sessions.gif" alt="A question, /exit prints the resume line, and --continue brings the conversation back" width="820"></p>

- **One task, no UI** for scripts and CI: `aihub-code -p "<task>"`, with
  `--output json` for a summary a program can read.

<p align="center"><img src="docs/media/headless.gif" alt="aihub-code -p answers a question, then fixes a test and prints JSON" width="820"></p>

- **Also:** images (paste a path or press Ctrl+V), knowledge bases in any
  chat (`/kb <name>`), MCP servers per session (`--mcp`), memory that learns
  from the chat, scheduled tasks while aihub-code is open, `/compact` when the
  context fills up, and `/agent` to talk to AIhub's chat or one of its agents
  instead of the coding agent.

## Using an Ollama server

To run the models on a stronger machine:

1. On that machine, make Ollama listen on the network by setting
   `OLLAMA_HOST=0.0.0.0`.
2. Point aihub-code at it: `/settings` → Ollama server, or AIhub's Settings, or
   `ollama_api_url` in `~/.aihub/config.yaml`.

The status line shows where the model runs: GPU, CPU, both, or cloud.

## Reference

<details>
<summary>Command line</summary>

```bash
aihub-code                     # start in the current folder
aihub-code --continue          # resume the newest session of this folder
aihub-code --resume [ID]       # pick an earlier session, or open one
aihub-code -p "<task>"         # one task, no UI
aihub-code update | uninstall | --version
```

Interactive options:

| Option | |
|---|---|
| `--model NAME` | default: your AIhub default chat model |
| `--mode plan\|build\|auto` | start in this mode (default `build`) |
| `--mcp NAME` | let the agent use this MCP server (repeatable) |
| `--kb NAME` | let the agent search this knowledge base (repeatable) |
| `--resume [ID]` | continue an earlier session of this folder; without an ID, pick one |
| `--continue` | continue this folder's newest session |

`-p` options:

| Option | |
|---|---|
| `-p`, `--prompt` | the task; runs one turn in the current folder and exits |
| `--mode plan\|build\|auto` | as above (default `build`) |
| `--model NAME` | default: your AIhub default chat model |
| `--output text\|json` | `json` prints one object: answer, files changed, refused calls, usage |
| `--mcp NAME`, `--kb NAME` | as above (repeatable) |

In a `-p` run there is nobody to ask, so in build mode the calls that need
approval are refused, and aihub-code says so. `-p` does not need Bun. Exit
codes: 0 done, 1 error, 2 bad input or the project is busy, 3 stopped at the
tool-round limit, 130 interrupted.
</details>

<details>
<summary>Slash commands</summary>

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

Ctrl+P opens a palette of all commands. To send text that starts with `/`,
start it with `//`.
</details>

<details>
<summary>Keys</summary>

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

Shift+Enter needs a terminal that supports the kitty keyboard protocol
(kitty, WezTerm, Ghostty, recent iTerm2 and others). In other terminals it
sends the message like Enter; **Ctrl+J always adds a line**.
</details>

<details>
<summary>Approvals, rules and modes in detail</summary>

The question replaces the prompt box. Press `1`, `2` or `3`, or use the arrow
keys and Enter:

1. **Yes.**
2. **Yes, and don't ask again** stores an allow rule for the project
   (`/rules` lists them, `/rules remove N` removes one). It is offered only
   when there is a rule to store.
3. **No, and tell the model what to do instead.**

Esc says no. Keys count only after half a second without typing, so a message
you are typing when the question appears can't answer it.

Writes outside the project or into `.git` are asked about in build mode and
refused in auto mode. `/undo` restores or deletes only the paths the last
turn changed and warns about files you changed since (`/undo force` goes
ahead anyway).

A "yes" to the trust question covers that folder and the folders under it
(kept in `~/.aihub/aihub-code-settings.json`), except your home folder or a
drive's root, which cover only themselves.
</details>

<details>
<summary><code>/agent</code>: what you talk to</summary>

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
then. A task's result is printed into the scrollback.
</details>

## aihub-code and AIhub

[AIhub](https://github.com/marceljurgiel/AIhub-TUI) is the full-screen app;
aihub-code is the coding tool with the hub inside. Both read and write the
same `~/.aihub`: the Ollama server, models, agents, memory, connections,
knowledge bases, scheduled tasks and per-model context sizes. Only the theme
and accent are separate. aihub-code installs AIhub's released engine as a
dependency and never changes it; you don't need AIhub's app.

A code session belongs to the folder it started in (undo, rules and sessions
are kept per folder), so to work on another project, start aihub-code there.

> **Status: early (0.3.0).** Developed on Linux and tried on Windows 11. CI
> runs the tests on Linux, macOS and Windows, but nobody has tried it by hand
> on a Mac yet. Small local models sometimes ask instead of acting; cloud
> models such as `gemma4:cloud` are the most reliable.

## How it is built

```
app/          interactive UI: TypeScript, React on OpenTUI, runs on Bun
aihub_code/   engine: Python, the agent harness on top of AIhub's engine
```

The UI starts the engine (`python -m aihub_code.bridge`) and the two talk
newline-delimited JSON over stdio.

## Development

```bash
git clone https://github.com/marceljurgiel/aihub-code && cd aihub-code
uv venv --python 3.12 && uv pip install -e ".[dev]"
(cd app && bun install)

.venv/bin/python -m pytest -q             # engine tests
(cd app && bun test && bunx tsc --noEmit)
```

Tests use a throwaway home folder and never touch `~/.aihub` or the network.
Behaviour decisions are in [docs/RULINGS.md](docs/RULINGS.md); the GIFs are
recorded with [docs/media/record.sh](docs/media/README.md). Bug reports and
ideas are welcome in the [issues](https://github.com/marceljurgiel/aihub-code/issues);
report security problems privately (see [SECURITY.md](SECURITY.md)).
aihub-code is MIT-licensed.
