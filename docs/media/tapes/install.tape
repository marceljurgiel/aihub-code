# aihub-code demo: the one-line installer
# Recorded with VHS (https://github.com/charmbracelet/vhs); see docs/media/README.md.
Output out/install.mp4
Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 15
Set Width 1280
Set Height 800
Set Padding 12
Set Framerate 12
Set TypingSpeed 40ms
# Off camera: serve install.sh and the package from this checkout, so the demo
# works before a release. Everything else is the real installer.
Hide
Type `export PATH=$HOME/.local/bin:$PATH PS1="$ " AIHUB_CODE_SOURCE=/pkg/aihub-code.tar.gz; curl() { case "$*" in *install.sh*) cat /pkg/install.sh;; *) command curl "$@";; esac; }; cd ~; clear`
Enter
Sleep 1s
Show
Sleep 800ms
Type "curl -fsSL https://raw.githubusercontent.com/marceljurgiel/aihub-code/main/install.sh | bash"
Sleep 800ms
Enter
Sleep 6s
# Downloads (uv, Python, Bun, the engine): cut.
Hide
Wait+Screen@900s /is installed/
Show
Sleep 3s
Screenshot out/install.png
Sleep 1s
Type "aihub-code --version"
Sleep 500ms
Enter
Sleep 3s
