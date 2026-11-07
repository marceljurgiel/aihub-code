# aihub-code demo: AIhub's windows as panels: models, agents, memory, the palette
# Recorded with VHS (https://github.com/charmbracelet/vhs); see docs/media/README.md.
Output out/hub.mp4
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
Type "/models"
Sleep 500ms
# The Installed tab lists the server's own models: open on Fit instead.
Hide
Enter
Sleep 2s
Right
Sleep 8s
Show
Sleep 2.5s
Down
Sleep 900ms
Down
Sleep 900ms
Down
Sleep 2.5s
Escape
Sleep 1.5s
Type "/agents"
Sleep 500ms
Enter
Sleep 3s
Down
Sleep 1.2s
Down
Sleep 2.5s
Escape
Sleep 1.5s
Type "/memory"
Sleep 500ms
Enter
Sleep 4s
Escape
Sleep 1.5s
Ctrl+P
Sleep 2s
Type "know"
Sleep 3s
Escape
Sleep 2s
