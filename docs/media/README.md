# Demo media

The GIFs in the main README are recorded with
[VHS](https://github.com/charmbracelet/vhs) from the tapes in `tapes/`,
inside a container with a demo user **alex**, a small project with a failing
test (`seed/shop`) and a demo memory. aihub-code is installed in the
container from your checkout's last commit, so nothing from your own machine
ends up in the frames.

```bash
OLLAMA_SERVER=192.0.2.10 docs/media/record.sh               # all tapes
OLLAMA_SERVER=192.0.2.10 docs/media/record.sh undo themes   # some of them
```

| Tape | Shows |
|---|---|
| `hero` | start-up, the trust question, a failing test found and fixed |
| `approvals` | build mode asks before an edit; "don't ask again" makes a rule |
| `plan` | plan mode reads and plans, changes nothing |
| `undo` | a fix undone with `/undo` |
| `hub` | the Models, Agents and Memory panels and the palette |
| `themes` | the theme picker colouring the terminal |
| `sessions` | `/exit` prints the resume line; `--continue` picks it up |
| `headless` | `-p`, as text and as JSON |
| `install` | the one-line installer |

- Needs podman and an Ollama server with the model (`MODEL=`, default
  `gemma4:cloud`). The server appears as `gpu-box.lan` in the recording.
- Each tape writes `<tape>.gif` here (made from the tape's video, which needs
  far less memory than VHS's own GIF output), some a `.png` too.
- The model answers differently each time; when a take looks odd, record that
  tape again. Look through the frames before committing, for example with
  `ffmpeg -i hero.gif -vf "fps=1/3,scale=700:-1,tile=4x3" sheet.png`.
