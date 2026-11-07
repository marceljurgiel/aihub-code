# aihub-code demo: build mode asks before an edit; a rule stops the next question
# Recorded with VHS (https://github.com/charmbracelet/vhs); see docs/media/README.md.
Output out/approvals.mp4
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
Type "Add a one-line docstring to subtotal() in cart.py. Only that edit; run nothing."
Sleep 600ms
Enter
Wait+Screen@240s /(edit|write)_file cart/
Sleep 4s
Screenshot out/approvals.png
Sleep 1s
# "Yes, and don't ask again for edit_file (this project)"
Type "2"
Sleep 12s
Type "Now add a one-line docstring to total() too. Only that edit; run nothing."
Sleep 600ms
Enter
Wait+Screen@240s /(edit|write)_file cart[\s\S]*(edit|write)_file cart/
Sleep 10s
Type "/rules"
Sleep 500ms
Enter
Sleep 6s
