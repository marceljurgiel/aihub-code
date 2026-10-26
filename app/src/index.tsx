import { createCliRenderer } from "@opentui/core";
import { IDLE_FOOTER_ROWS, launch } from "./app";
import { parseArgs } from "./args";
import { BridgeClient } from "./bridge/client";
import { applyTheme } from "./hub/theme";
import { applyConfigAccent, codeTheme, configKey } from "./theme";

// A split-footer renderer: the transcript is written to the terminal's own
// scrollback, only the footer is redrawn. Printed output (console.log, stray
// stdout) is captured and routed above the footer instead of tearing it.
// exitOnCtrlC: false and no process.exit(): quitting is renderer.destroy(),
// which restores the terminal (a hard exit would leave it in raw mode).
// clearOnShutdown: false keeps the visible transcript for the shell.
applyConfigAccent();
// AIhub's windows: aihub-code's own theme setting (none: the "terminal" theme,
// no backgrounds, the terminal's own colours; AIhub's `theme:` is ignored) and
// AIhub's accent, as the rest of the app uses it.
applyTheme(codeTheme(), configKey("accent"));
const renderer = await createCliRenderer({
  screenMode: "split-footer",
  footerHeight: IDLE_FOOTER_ROWS,
  externalOutputMode: "capture-stdout",
  exitOnCtrlC: false,
  clearOnShutdown: false,
});

const bridge = new BridgeClient();
bridge.start();

launch({
  renderer,
  bridge,
  args: parseArgs(process.env),
  cwd: process.cwd(),
  // After the terminal is restored: a plain line in the shell, not in the transcript.
  onClosed: (line) => {
    if (line) process.stdout.write(`${line}\n`);
  },
});
