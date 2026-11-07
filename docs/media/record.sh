#!/usr/bin/env bash
# Record the README media from the committed code.
#
#   OLLAMA_SERVER=<address of an Ollama server> docs/media/record.sh [tape …]
#
# Needs podman. The server is reached as "gpu-box.lan" inside the recording,
# so its real address never shows. Tapes: hero approvals plan undo hub themes
# sessions headless install. MODEL=<name> picks the model (default
# gemma4:cloud). Each tape writes docs/media/<tape>.mp4 and <tape>.gif (made
# from the video: VHS's own GIF render needs more memory), some a .png too.
set -euo pipefail
: "${OLLAMA_SERVER:?set OLLAMA_SERVER to your Ollama server, e.g. OLLAMA_SERVER=192.0.2.10}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/pkg" "$work/out"; chmod 777 "$work/out"

git -C "$root" archive --prefix=aihub-code-main/ -o "$work/pkg/aihub-code.tar.gz" HEAD
cp "$root/install.sh" "$work/pkg/"
cp -r "$here/seed" "$here/Containerfile.base" "$here/Containerfile.demo" "$work/"
podman build -q -t aihub-code-vhs-base -f "$work/Containerfile.base" "$work" >/dev/null
podman build -q -t aihub-code-vhs --build-arg "MODEL=${MODEL:-gemma4:cloud}" \
  -f "$work/Containerfile.demo" "$work" >/dev/null

cp -r "$here/tapes" "$work/tapes"
failed=""
for t in ${@:-hero approvals plan undo hub themes sessions headless install}; do
  image=aihub-code-vhs; [ "$t" = install ] && image=aihub-code-vhs-base
  # A model can answer oddly or a run can be cut short: one more try, then
  # carry on with the rest.
  ok=""
  for attempt in 1 2; do
    echo "recording $t (try $attempt)"
    rm -f "$work/out/$t".* "$work/out/$t"-*.png
    if podman run --rm --userns=keep-id --user alex -e HOME=/home/alex -w /vhs --hostname demo-pc \
         --add-host "gpu-box.lan:$OLLAMA_SERVER" \
         -v "$work/tapes:/vhs:Z" -v "$work/out:/vhs/out:Z" "$image" "/vhs/$t.tape"; then
      ok=1; break
    fi
  done
  if [ -z "$ok" ]; then failed="$failed $t"; continue; fi
  podman run --rm -v "$work/out:/out:Z" --entrypoint ffmpeg aihub-code-vhs-base -v error -y -i "/out/$t.mp4" \
    -vf "fps=10,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
    "/out/$t.gif"
  cp "$work/out/$t".* "$here/"
done
if [ -n "$failed" ]; then
  echo "done, except:$failed — run again with just those"
  exit 1
fi
echo "done — check the frames before committing (no real names, paths or addresses)"
