# aihub-code demo: start-up, then a failing test found and fixed
# Recorded with VHS (https://github.com/charmbracelet/vhs); see docs/media/README.md.
Output out/hero.mp4
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
Type "aihub-code"
Sleep 400ms
Enter
Wait+Screen@90s /trust the files/
Sleep 2.5s
Enter
Wait+Screen@90s /shift\+tab mode/
Sleep 3.5s
# build -> auto: no questions for this fix
Shift+Tab
Sleep 1.5s
Type "The tests fail. Find the bug and fix it, then run the tests."
Sleep 600ms
Enter
Wait+Screen@240s /3 passed/
Sleep 12s
Screenshot out/hero.png
Sleep 1s
