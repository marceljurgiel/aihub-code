# aihub-code demo: plan mode reads and plans, changes nothing
# Recorded with VHS (https://github.com/charmbracelet/vhs); see docs/media/README.md.
Output out/plan.mp4
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
# build → auto → plan
Shift+Tab
Sleep 1s
Shift+Tab
Sleep 2s
Type "How would you add coupon codes to the cart? A short plan; change nothing."
Sleep 600ms
Enter
Wait+Screen@60s /esc to interrupt/
Wait+Screen@240s /\n *\n╭/
Sleep 8s
