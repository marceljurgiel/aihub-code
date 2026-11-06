# Demo media

The demo at the top of the main README is recorded with
[VHS](https://github.com/charmbracelet/vhs) from `tapes/demo.tape`, inside a
container with a demo user **alex** and a tiny project with a failing test
(`seed/shop`). aihub-code is installed in the container from your checkout's
last commit, so nothing from your own machine ends up in the frames.

```bash
OLLAMA_SERVER=192.0.2.10 docs/media/record.sh
MODEL=gemma4:cloud OLLAMA_SERVER=192.0.2.10 docs/media/record.sh
```

- Needs podman and an Ollama server with the model (default `gemma4:cloud`).
  The server appears as `gpu-box.lan` in the recording.
- It writes `demo.gif`, `demo.mp4` and `demo.png` here.
- The model answers differently each time; when a take looks odd, record
  again. Look through the frames before committing, for example with
  `ffmpeg -i demo.gif -vf "fps=1/3,scale=700:-1,tile=4x3" sheet.png`.
