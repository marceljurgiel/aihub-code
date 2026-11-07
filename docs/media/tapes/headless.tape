# aihub-code demo: one task without the UI: -p, also as JSON
# Recorded with VHS (https://github.com/charmbracelet/vhs); see docs/media/README.md.
Output out/headless.mp4
Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 15
Set Width 1280
Set Height 800
Set Padding 12
Set Framerate 12
Set TypingSpeed 40ms
Hide
Type "export PATH=$HOME/.local/bin:$PATH PS1='$ '; cd ~/shop; clear"
Enter
Sleep 1s
Show
Sleep 800ms
Type `aihub-code -p "Why do the tests fail? One sentence." --mode plan`
Sleep 600ms
Enter
Wait@180s /^\$$/
Sleep 3s
Type `aihub-code -p "Fix the failing test." --mode auto --output json | python3 -m json.tool`
Sleep 600ms
Enter
Wait@240s /^\$$/
Sleep 6s
