# aihub-code demo: a turn undone with /undo
# Recorded with VHS (https://github.com/charmbracelet/vhs); see docs/media/README.md.
Output out/undo.mp4
Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 15
Set Width 1280
Set Height 800
Set Padding 12
Set Framerate 12
Set TypingSpeed 40ms
Hide
Type `export PATH=$HOME/.local/bin:$PATH PS1='$ '; cd ~/shop; printf '{"theme": "aihub", "trusted": ["/home/alex/shop"]}' > ~/.aihub/aihub-code-settings.json; clear`
Enter
Sleep 1s
Show
Sleep 800ms
Type "aihub-code"
Sleep 400ms
Enter
Wait+Screen@90s /shift\+tab mode/
Sleep 3s
Shift+Tab
Sleep 1.5s
Type "The tests fail. Find the bug and fix it, then run the tests."
Sleep 600ms
Enter
Wait+Screen@60s /esc to interrupt/
Wait+Screen@240s /\n *\n╭/
Sleep 4s
Type "/undo"
Sleep 500ms
Enter
Wait+Screen@60s /Undo these changes/
Sleep 4s
Type "y"
Sleep 4s
Type "/exit"
Sleep 400ms
Enter
Sleep 2.5s
Type "git status --short; python3 -m pytest -q | tail -1"
Sleep 500ms
Enter
Sleep 5s
