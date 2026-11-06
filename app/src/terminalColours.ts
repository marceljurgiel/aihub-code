/**
 * The transcript lives in the terminal's own scrollback, where aihub-code
 * paints no background. So a hub theme with its own colours (not the
 * "terminal" theme) sets the terminal's default background and text colour
 * while aihub-code runs — OSC 11 and OSC 10 — and the terminal's own come
 * back (OSC 111 / 110) for the terminal theme and when aihub-code closes.
 * Terminals that don't know these sequences ignore them.
 */
import { subscribeTheme, theme } from "./hub/theme";

/** OSC 111 and 110: the terminal's own background and text colour back.
 *  Windows' ConPTY (Windows Terminal, OpenSSH) drops the bare form and passes
 *  them on with an empty parameter, so there they carry a ';'. */
export function resetSequence(platform: string = process.platform): string {
  return platform === "win32" ? "\x1b]111;\x07\x1b]110;\x07" : "\x1b]111\x07\x1b]110\x07";
}

export const RESET = resetSequence();

const HEX = /^#[0-9a-f]{6}$/i;
const rgb = (hex: string): string => `rgb:${hex.slice(1, 3)}/${hex.slice(3, 5)}/${hex.slice(5, 7)}`.toLowerCase();

/** The sequences for the active theme's background and text, or null when it
 *  keeps the terminal's own (its canvas is see-through or not a plain colour). */
export function themeColours(): string | null {
  const bg = theme.bg0;
  const fg = theme.fg0;
  if (typeof bg !== "string" || !HEX.test(bg) || typeof fg !== "string" || !HEX.test(fg)) return null;
  return `\x1b]11;${rgb(bg)}\x07\x1b]10;${rgb(fg)}\x07`;
}

/** Keep the terminal's colours on the theme from now on; `restore()` puts the
 *  terminal's own back and stops. Writes that fail are ignored. */
export function followTheme(write: (seq: string) => void): { restore(): void } {
  let current: string | null = null; // what was last set; null: the terminal's own
  const send = (seq: string) => {
    try {
      write(seq);
    } catch {
      // the terminal is gone or closing: nothing to colour
    }
  };
  const sync = () => {
    const want = themeColours();
    if (want === current) return;
    send(want ?? RESET);
    current = want;
  };
  const stop = subscribeTheme(sync);
  sync();
  return {
    restore() {
      stop();
      if (current !== null) send(RESET);
      current = null;
    },
  };
}
