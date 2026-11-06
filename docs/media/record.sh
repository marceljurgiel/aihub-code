#!/usr/bin/env bash
# Record the README's demo from the committed code.
#
#   OLLAMA_SERVER=<address of an Ollama server> docs/media/record.sh
#
# Needs podman. The server is reached as "gpu-box.lan" inside the recording,
# so its real address never shows. MODEL=<name> picks the model (default
# gemma4:cloud). Writes docs/media/demo.gif, demo.mp4 and demo.png.
set -euo pipefail
: "${OLLAMA_SERVER:?set OLLAMA_SERVER to your Ollama server, e.g. OLLAMA_SERVER=192.0.2.10}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/pkg" "$work/out"; chmod 777 "$work/out"

git -C "$root" archive --prefix=aihub-code-main/ -o "$work/pkg/aihub-code.tar.gz" HEAD
cp "$root/install.sh" "$work/pkg/"
cp -r "$here/seed" "$here/Containerfile" "$work/"
podman build -q -t aihub-code-vhs --build-arg "MODEL=${MODEL:-gemma4:cloud}" \
  -f "$work/Containerfile" "$work" >/dev/null

cp -r "$here/tapes" "$work/tapes"
# A model can answer oddly: one more try.
for attempt in 1 2; do
  echo "recording demo (try $attempt)"
  if podman run --rm --userns=keep-id --user alex -e HOME=/home/alex -w /vhs --hostname demo-pc \
       --add-host "gpu-box.lan:$OLLAMA_SERVER" \
       -v "$work/tapes:/vhs:Z" -v "$work/out:/vhs/out:Z" aihub-code-vhs /vhs/demo.tape; then
    cp "$work/out/"* "$here/"
    echo "done — check the frames before committing (no real names, paths or addresses)"
    exit 0
  fi
done
echo "the recording failed twice" >&2
exit 1
