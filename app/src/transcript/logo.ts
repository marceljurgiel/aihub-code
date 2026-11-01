/**
 * AIhub's wordmark at the top of the transcript when aihub-code starts — the
 * same rows as AIhub's sidebar. The hub theme's gradient where it has real
 * colours; the terminal theme (no backgrounds, colours unknown) takes the
 * accent for every row.
 */
import { flatTheme, logoGradient, logoLines } from "../hub/theme";
import type { Line } from "../scrollback";
import { palette } from "../theme";

const WIDTH = 1 + Math.max(...logoLines.map((l) => l.length));

/** The logo, one space in, and a blank row under it; nothing when it can't fit. */
export function fmtLogo(width: number): Line[] {
  if (width < WIDTH) return [];
  const rows = logoLines.map((text, i): Line => {
    const c = logoGradient[i];
    const fg = !flatTheme() && typeof c === "string" && c.startsWith("#") ? c : palette.accent;
    return [{ text: ` ${text}`.trimEnd(), fg, bold: true }];
  });
  return [...rows, []];
}
