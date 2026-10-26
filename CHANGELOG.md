# Changelog

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
