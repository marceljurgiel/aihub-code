# aihub-code demo: themes colour the whole terminal
# Recorded with VHS (https://github.com/charmbracelet/vhs); see docs/media/README.md.
Output out/themes.mp4
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
Type "/theme"
Sleep 500ms
Enter
Sleep 2.5s
Down
Sleep 1.6s
Down
Sleep 1.6s
Down
Sleep 1.6s
Down
Sleep 1.6s
Down
Sleep 1.6s
Up
Sleep 1.6s
Up
Sleep 1.6s
Enter
Sleep 3s
