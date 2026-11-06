# aihub-code demo — fix a failing test, then an edit that asks first.
# Recorded with VHS (https://github.com/charmbracelet/vhs); see docs/media/README.md.
Output out/demo.mp4
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
# build → auto: no questions for this task
Shift+Tab
Sleep 1.5s
Type "The tests fail. Find the bug and fix it, then run the tests."
Sleep 600ms
Enter
Wait+Screen@240s /3 passed/
Sleep 14s
Screenshot out/demo.png
Sleep 1s
# back to build: edits ask first
Type "/mode build"
Sleep 500ms
Enter
Sleep 8s
Type "Add a one-line docstring to test_subtotal in test_cart.py. Only that edit; run nothing."
Sleep 600ms
Enter
# the call is in the transcript; the question about it is in the footer
Wait+Screen@180s /(edit|write)_file test_cart/
Sleep 3.5s
Type "1"
Sleep 12s
Type "/exit"
Sleep 400ms
Enter
Sleep 3s
