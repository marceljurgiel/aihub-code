# aihub-code demo — fix a failing test, then an edit that asks first.
# Recorded with VHS (https://github.com/charmbracelet/vhs); see docs/media/README.md.
Output out/demo.gif
Output out/demo.mp4
Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 16
Set Width 1400
Set Height 860
Set Padding 12
Set Framerate 20
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
# build → auto: no questions for this task
Shift+Tab
Sleep 1.5s
Type "The tests fail. Find the bug and fix it, then run the tests."
Sleep 600ms
Enter
Wait+Screen@240s /3 passed/
Sleep 9s
Screenshot out/demo.png
Sleep 1s
# auto → plan → build: edits ask first
Shift+Tab
Sleep 700ms
Shift+Tab
Sleep 1.5s
Type "Add a one-line docstring to test_subtotal in test_cart.py. Only that edit; run nothing."
Sleep 600ms
Enter
Wait+Screen@180s /Allow /
Sleep 3s
Type "1"
Sleep 10s
Type "/exit"
Sleep 400ms
Enter
Sleep 3s
