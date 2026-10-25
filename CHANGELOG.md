# Changelog

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
