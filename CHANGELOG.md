# Changelog

## [0.3.0] - 2026-10-30

All of AIhub in the CLI.

### Added
- AIhub's windows as panels above the prompt: `/models`, `/hardware`,
  `/agents`, `/skills`, `/memory`, `/mcp`, `/knowledge`, `/schedule`,
  `/history`, `/settings`, `/theme`, `/temp`. Esc closes a panel and the
  conversation is shown again. Ctrl+P opens a palette of all commands.
- `/agent [code|chat|name]`: talk to the code agent (default), to AIhub's
  plain chat or to one of its agent profiles. Switching to or from the code
  agent starts a new conversation; chat and the profiles share one.
- Memory that learns new facts after a reply, `/memoryadd`, skills
  (`/skill <name> [task]`), knowledge bases (`/kb`) and MCP connections
  switched on mid-session, in every kind.
- Images: type or paste an image path, or paste an image from the clipboard
  (Ctrl+V), to attach it.
- Scheduled tasks run in the background; their results are printed into the
  scrollback, and a missed run asks first.
- A status line with the model and where it runs, the kind and mode, context
  used, `kb:<name>`, `mcp:on` and a running task.
- A theme other than "terminal" colours the whole terminal (background and
  text) while aihub-code runs, not only the text; closing puts the
  terminal's own colours back.
- `/tools`, `/websearch` (AIhub's one-shot search check), `/temp`, and `/new`
  as an alias of `/clear`.
- An "AIhub CODE" logo with a gradient at start-up, a one-sentence "Did
  you know?" tip about AIhub or agentic AI that types itself out above the
  prompt (gone after the first prompt), and "Do you trust the files in this folder?"
  the first time aihub-code starts in a folder (as Claude Code asks): yes is
  remembered for the folder and the ones under it, no leaves. `-p` doesn't
  ask.
- A note at start when a newer Ollama is out.
- The Installed tab of `/models` shows where each local model runs (GPU,
  part, CPU, ✗) and how fast (✓ = measured on your machine), and lists the
  best fit first, then cloud models.

### Changed
- `/clear` and `/new` start from a fresh screen; the old session's resume
  command is shown as one dim line.
- `/model` with no name opens the model panel.
- Panels use the terminal's own colours by default. Theme and accent are
  aihub-code's own (`~/.aihub/aihub-code-settings.json`); changing them does
  not change AIhub. Everything else is shared with AIhub in `~/.aihub`.

### Removed
- `/hub`: the hub is now inside.

### Notes
- No `/cd`: a code session belongs to the folder it was started in. Start
  aihub-code in another folder instead.
- No Update-Ollama panel and no F8 terminal: the update command is printed,
  and you are already in a terminal.
- Scheduled tasks run only while aihub-code is open; the shortest interval
  is 5 minutes, as in AIhub.
- Tried on Linux only.

## [0.2.0] - 2026-10-26

The interactive CLI: `aihub-code` in a project folder now opens a
Claude-Code-style prompt.

### Added
- A line UI on Bun and OpenTUI: the conversation goes into the normal
  terminal scrollback (selectable, kept after exit); only the activity line,
  the permission question, the prompt box and the status line are redrawn.
- Tool calls and results as they happen, with diffs for edits, shell output
  tails, the todo list and compaction notes; the reply streams in with light
  Markdown.
- Approvals in build mode: yes, yes and don't ask again (stored as a project
  rule), or no with a note to the model.
- Modes plan, build and auto, switched with Shift+Tab, `/mode` or `/plan`.
- A multi-line prompt box (Shift+Enter or Ctrl+J for a new line), prompt
  history, slash suggestions with Tab, messages queued while a turn runs.
- Slash commands: `/help`, `/mode`, `/plan`, `/model`, `/undo`, `/compact`,
  `/todos`, `/rules`, `/sessions`, `/resume`, `/clear`, `/context`, `/exit`,
  `/hub`.
- Sessions: `--resume [ID]` and `--continue` replay the earlier conversation;
  leaving prints the command to resume.
- `--model`, `--mode`, `--mcp` and `--kb` for the interactive command.
- The installers set up Bun (if missing) and the app's packages, and keep
  them across updates.

### Changed
- `aihub-code` without `-p` opens the UI (it printed a hint before); `-p` is
  unchanged and does not need Bun.
- Windows launcher: `aihub-code update` is one command line (cmd re-reads a
  rewritten batch file by byte offset), and `aihub-code uninstall` no longer
  breaks on an install path containing a closing parenthesis and reports
  "removed" only when the folder is gone.

### Notes
- Tried on Linux only; the Windows and macOS installers and the UI have not
  been tried there yet.

## [0.1.0] - 2026-10-26

First version: the coding harness of AIhub's engine as its own program.

### Added
- `aihub-code -p "task"`: one coding turn in the current folder, with
  `--mode plan|build|auto`, `--model`, `--output text|json`, `--mcp`, `--kb`
  and documented exit codes.
- Tools: numbered `read_file`, byte-preserving `edit_file` and `write_file`
  (CRLF and latin-1 files keep their bytes), `search_files`, `list_files`,
  `run_terminal` with timeouts and cancellation, `todo_write`.
- Permissions per mode with allow rules (session and project), protected
  `.git` and out-of-project paths, dangerous-command detection.
- Per-turn checkpoints in a shadow git repository (or file copies) with
  turn-scoped undo, conflict detection and a per-project lock.
- Context compaction between rounds and inside long turns.
- An NDJSON bridge (`aihub-code-bridge`) with the `code.*` methods for the
  coming interactive UI.
- Installers for Linux, macOS and Windows with their own environment and an
  `aihub-code` launcher.

### Notes
- Depends on AIhub 1.5.0 (installed from its git tag), unmodified. The
  engine pieces the harness had to change are copies in `aihub_code/engine/`.
- Not yet checked on Windows or macOS.
