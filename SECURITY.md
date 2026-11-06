# Security

## Supported versions

Only the latest version gets fixes. Update with `aihub-code update`.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem. Report it
privately instead:

1. Go to this repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe what you found, how to reproduce it, and what an attacker could
   do with it.

Only the maintainer sees the report and will answer as soon as possible. Once
a fix is released, the advisory is published with credit to you, unless you'd
rather stay anonymous.

## What aihub-code can do on your machine

aihub-code is a coding agent: the model reads files, edits them and runs
commands in the folder you start it in.

- The first time it starts in a folder, it asks whether you trust the files
  there. The project's `AGENTS.md` or `CLAUDE.md` becomes part of the prompt,
  so only trust projects whose instructions you would follow yourself.
- **build** mode asks before an edit or a command that your rules don't
  cover. **plan** mode refuses edits and commands. **auto** mode doesn't ask,
  except for dangerous commands — it is **not a sandbox**, so use it only in
  projects you can restore.
- Writes outside the project or into `.git` are asked about in build mode
  and refused in auto mode.
- `/undo` restores the files a turn changed from a snapshot outside your
  project. Shell commands are not reverted.

## What aihub-code does with your data

- It talks to the Ollama server you choose. Conversations, sessions, rules,
  memory and settings stay in `~/.aihub`.
- Requests leave your network only when you pick a cloud model or use a
  connection (Gmail, GitHub…) — then they go to that service.
