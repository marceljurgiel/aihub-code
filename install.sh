#!/usr/bin/env bash
# aihub-code installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/marceljurgiel/aihub-code/main/install.sh | bash
#
# Installs aihub-code without root, in its own Python environment: uv (Python
# 3.12), aihub-code and the AIhub engine it builds on (needs git), Bun (it runs
# the interactive terminal UI) plus a launcher at ~/.local/bin/aihub-code. It
# reads your AIhub settings (~/.aihub) and never touches them. Re-running it
# updates aihub-code.
#
# Options:
#   --dir <path>   install directory (default: ~/.local/share/aihub-code)
#
# Environment: AIHUB_CODE_SOURCE  tarball URL or local .tar.gz to install from
#              AIHUB_CODE_REF     branch or tag on GitHub (default: main)
set -euo pipefail

REPO="marceljurgiel/aihub-code"
REF="${AIHUB_CODE_REF:-main}"
SOURCE="${AIHUB_CODE_SOURCE:-https://github.com/$REPO/archive/refs/heads/$REF.tar.gz}"
INSTALLER_URL="https://raw.githubusercontent.com/$REPO/main/install.sh"
HOME_DIR="${AIHUB_CODE_HOME:-$HOME/.local/share/aihub-code}"
BIN_DIR="$HOME/.local/bin"

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; C=""; N=""
fi
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s+%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

fetch() {  # fetch URL FILE
  if have curl; then curl -fsSL --retry 3 -o "$2" "$1"
  elif have wget; then wget -q -O "$2" "$1"
  else die "curl or wget is required"; fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) HOME_DIR="${2:-}"; shift ;;
      --dir=*) HOME_DIR="${1#*=}" ;;
      -h|--help) sed -n '2,16p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "unknown option: $1 (try --help)" ;;
    esac
    shift
  done
}

version_of() {
  sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$HOME_DIR/pyproject.toml" | head -1
}

# Only a folder that is an aihub-code install (or empty) may be replaced: the
# directory is moved aside and deleted on update, so --dir ~/tools must never
# be taken for one.
is_install_dir() {
  [ -x "$1/.venv/bin/aihub-code" ] || grep -qs '^name[[:space:]]*=[[:space:]]*"aihub-code"' "$1/pyproject.toml"
}

check_install_dir() {
  [ -e "$1" ] || return 0
  [ -d "$1" ] || { printf '%s is not a directory - choose a new or empty directory\n' "$1" >&2; return 1; }
  [ -z "$(ls -A "$1")" ] && return 0
  is_install_dir "$1" && return 0
  printf '%s is not an aihub-code install - choose a new or empty directory (--dir). Nothing was changed.\n' "$1" >&2
  return 1
}

install_source() {
  check_install_dir "$HOME_DIR" || exit 1
  step "Downloading aihub-code"
  mkdir -p "$(dirname "$HOME_DIR")"
  tmp="$(mktemp -d "$(dirname "$HOME_DIR")/.aihub-code-install.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  if [ -f "$SOURCE" ]; then cp "$SOURCE" "$tmp/src.tar.gz"; else fetch "$SOURCE" "$tmp/src.tar.gz"; fi
  mkdir -p "$tmp/src"
  tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components=1 || die "the download is not a valid archive: $SOURCE"
  [ -f "$tmp/src/pyproject.toml" ] && [ -d "$tmp/src/aihub_code" ] || die "the archive does not look like aihub-code: $SOURCE"
  # Update: move the old install aside (nothing changes if that fails), keep
  # its Python environment and the app's packages, swap the new source in.
  if [ -d "$HOME_DIR" ]; then
    mv "$HOME_DIR" "$tmp/old" || die "could not move the old install aside ($HOME_DIR) - nothing was changed"
    [ -d "$tmp/old/.venv" ] && mv "$tmp/old/.venv" "$tmp/src/.venv"
    [ -d "$tmp/old/app/node_modules" ] && mv "$tmp/old/app/node_modules" "$tmp/src/app/node_modules"
  fi
  mv "$tmp/src" "$HOME_DIR"
  ok "aihub-code $(version_of) -> $HOME_DIR"
}

install_engine() {
  step "Python environment"
  have git || die "git is required (the AIhub engine is installed from GitHub)"
  local uv=""
  for c in uv "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv"; do
    if have "$c" || [ -x "$c" ]; then uv="$(command -v "$c" || echo "$c")"; break; fi
  done
  if [ -z "$uv" ]; then
    fetch https://astral.sh/uv/install.sh "$HOME_DIR/.uv-install.sh"
    UV_NO_MODIFY_PATH=1 sh "$HOME_DIR/.uv-install.sh" -q >/dev/null || die "could not install uv"
    rm -f "$HOME_DIR/.uv-install.sh"
    uv="$HOME/.local/bin/uv"
    ok "uv installed"
  fi
  [ -x "$HOME_DIR/.venv/bin/python" ] || "$uv" venv -q --python 3.12 "$HOME_DIR/.venv" || die "could not create the Python environment"
  "$uv" pip install -q --python "$HOME_DIR/.venv/bin/python" -e "$HOME_DIR" || die "could not install aihub-code and the AIhub engine"
  ok "aihub-code $("$HOME_DIR/.venv/bin/python" -c 'import aihub_code; print(aihub_code.__version__)'), AIhub engine $("$HOME_DIR/.venv/bin/python" -c 'import aihub; print(aihub.__version__)')"
}

bun_target() {
  local os arch target
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported system: $os" ;; esac
  case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=aarch64 ;; *) die "unsupported CPU: $arch" ;; esac
  target="$os-$arch"
  if [ "$os" = linux ]; then
    if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then target="$target-musl"; fi
    if [ "$arch" = x64 ] && ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then target="$target-baseline"; fi
  elif [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 1)" = 0 ]; then
    target="$target-baseline"
  fi
  printf '%s' "$target"
}

# Bun runs the interactive UI (app/). Found on PATH or in ~/.bun/bin, else
# installed there (the same place aihub-code looks).
install_app() {
  step "Terminal UI"
  BUN=""
  if have bun; then BUN="$(command -v bun)"; elif [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
  if [ -z "$BUN" ]; then
    # The official installer needs `unzip`; unpacking with our own Python doesn't.
    local target zip
    target="$(bun_target)"; zip="$HOME_DIR/.bun.zip"
    fetch "https://github.com/oven-sh/bun/releases/latest/download/bun-$target.zip" "$zip" || die "could not download Bun"
    mkdir -p "$HOME/.bun/bin"
    "$HOME_DIR/.venv/bin/python" - "$zip" "$target" "$HOME/.bun/bin/bun" <<'PY'
import shutil, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z, z.open(f"bun-{sys.argv[2]}/bun") as src, open(sys.argv[3], "wb") as dst:
    shutil.copyfileobj(src, dst)
PY
    chmod +x "$HOME/.bun/bin/bun"; rm -f "$zip"
    BUN="$HOME/.bun/bin/bun"
    ok "Bun $("$BUN" --version) installed"
  fi
  (cd "$HOME_DIR/app" && "$BUN" install --production --frozen-lockfile >/dev/null 2>&1) \
    || (cd "$HOME_DIR/app" && "$BUN" install --production) || die "could not install the app's packages"
  ok "terminal UI ready (Bun $("$BUN" --version))"
}

install_launcher() {
  step "Launcher"
  mkdir -p "$BIN_DIR"
  rm -f "$BIN_DIR/aihub-code"
  cat >"$BIN_DIR/aihub-code" <<LAUNCHER
#!/bin/sh
# aihub-code launcher (written by install.sh). Re-run the installer to update.
AIHUB_CODE_HOME="$HOME_DIR"
case "\${1:-}" in
  update)    shift; t="\$(mktemp)" || exit 1
             if command -v curl >/dev/null 2>&1; then curl -fsSL -o "\$t" "$INSTALLER_URL"
             elif command -v wget >/dev/null 2>&1; then wget -q -O "\$t" "$INSTALLER_URL"
             else echo "curl or wget is required" >&2; rm -f "\$t"; exit 1; fi \\
               && bash "\$t" --dir "\$AIHUB_CODE_HOME" "\$@"
             r=\$?; rm -f "\$t"; exit \$r ;;
  uninstall) if [ ! -x "\$AIHUB_CODE_HOME/.venv/bin/aihub-code" ] && ! grep -qs '^name[[:space:]]*=[[:space:]]*"aihub-code"' "\$AIHUB_CODE_HOME/pyproject.toml"; then
               echo "\$AIHUB_CODE_HOME is not an aihub-code install - nothing was removed." >&2; exit 1
             fi
             printf 'Remove aihub-code from %s? Your AIhub settings and chats in ~/.aihub stay. [y/N] ' "\$AIHUB_CODE_HOME"
             read -r a; [ "\$a" = y ] || exit 1
             rm -rf "\$AIHUB_CODE_HOME" "\$0"; echo "aihub-code removed."; exit 0 ;;
esac
exec "\$AIHUB_CODE_HOME/.venv/bin/aihub-code" "\$@"
LAUNCHER
  chmod +x "$BIN_DIR/aihub-code"
  ok "$BIN_DIR/aihub-code"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      local line="export PATH=\"\$HOME/.local/bin:\$PATH\"" rc added=""
      for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        [ -f "$rc" ] || continue
        grep -qs '.local/bin' "$rc" || { printf '\n%s\n' "$line" >>"$rc"; added="$added $rc"; }
      done
      [ -n "$added" ] && ok "added ~/.local/bin to PATH in$added"
      warn "open a new terminal (or run: export PATH=\"\$HOME/.local/bin:\$PATH\") to use aihub-code" ;;
  esac
}

main() {
  parse_args "$@"
  install_source
  install_engine
  install_app
  install_launcher
  printf '\n%saihub-code is installed.%s In a project folder: aihub-code\n' "$B" "$N"
  have ollama || warn "no local Ollama found - aihub-code uses the server or cloud models set up in AIhub (~/.aihub)"
}

# Sourcing the file (AIHUB_CODE_SOURCED=1) loads the functions without installing.
[ -n "${AIHUB_CODE_SOURCED:-}" ] || main "$@"
