import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

// A split-footer renderer: the transcript is written to the terminal's own
// scrollback, only this footer is redrawn. Printed output (console.log, stray
// stdout) is captured and routed above the footer instead of tearing it.
// exitOnCtrlC: false and no process.exit(): quitting is renderer.destroy(),
// which restores the terminal (a hard exit would leave it in raw mode).
const renderer = await createCliRenderer({
  screenMode: "split-footer",
  footerHeight: 1,
  externalOutputMode: "capture-stdout",
  exitOnCtrlC: false,
});

renderer.keyInput.on("keypress", (key) => {
  if (key.ctrl && key.name === "c") renderer.destroy();
});

// Placeholder footer; the real one arrives with the prompt (task 4).
createRoot(renderer).render(<text>aihub-code</text>);
