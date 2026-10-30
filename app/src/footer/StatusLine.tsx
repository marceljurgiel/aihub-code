/** The dim line under the box: model · location, mode, context, kb / mcp, task · what the keys do. */
import type { Line, Span } from "../scrollback";
import { modeColor, palette } from "../theme";
import { fitItems, STATUS_SEP } from "../session/status";
import { displayWidth, splitAtWidth } from "../width";
import { LineText } from "./LineText";

export interface StatusInput {
  /** The kind and mode word (item 2 below), which carries the mode's colour. */
  mode: string;
  /** What statusItems says, in order (model · location, the kind and mode,
   *  ctx, kb / mcp, task): they give way from the end. */
  items: string[];
  queued: number;
  /** The key hints when nothing replaces them (default DEFAULT_HINTS). */
  hints?: string[];
  /** Replaces the key hints (a question, or the keys of a prompt). */
  hint?: { text: string; warn?: boolean } | null;
}

const SEP = STATUS_SEP;
const dim = (text: string): Span => ({ text, dim: true });

export const DEFAULT_HINTS = ["shift+tab mode", "/help"];
export const CHAT_HINTS = ["/agent switch", "/help"];

/** Left to right; the width decides how many of the tail segments survive:
 *  the key hints go first, then the items from the end, then the model is cut. */
export function statusLine(s: StatusInput, width: number): Line {
  const right = s.queued > 0 ? `queued ${s.queued}` : "";
  const hints: Span[][] = s.hint ? [[s.hint.warn ? { text: s.hint.text, fg: palette.yellow } : dim(s.hint.text)]] : (s.hints ?? DEFAULT_HINTS).map((h) => [dim(h)]);
  // Item 2 is the mode word (when it is still there).
  const segs = (items: string[], nHints: number): Span[][] => [
    ...items.map((t, i): Span[] => [i === 1 ? { text: t, fg: modeColor(s.mode), bold: true } : dim(t)]),
    ...hints.slice(0, nHints),
  ];
  const widthOf = (parts: Span[][]) => 1 + parts.reduce((w, p, i) => w + (i ? SEP.length : 0) + p.reduce((x, sp) => x + displayWidth(sp.text), 0), 0);
  const join = (parts: Span[][]): Line => [{ text: " " }, ...parts.flatMap((p, i) => (i ? [dim(SEP), ...p] : p))];

  const reserve = right ? displayWidth(right) + 2 : 0;
  for (let n = hints.length; n >= 0; n--) {
    const parts = segs(s.items, n);
    if (widthOf(parts) + reserve <= width) return withRight(join(parts), widthOf(parts), right, width);
  }
  const kept = fitItems(s.items, width - reserve);
  const parts = segs(kept, 0);
  if (widthOf(parts) + reserve <= width) return withRight(join(parts), widthOf(parts), right, width);
  // Very narrow: the left part alone, cut.
  if (widthOf(parts) <= width) return join(parts);
  return splitAtWidth(join(parts), width)[0] ?? [];
}

function withRight(line: Line, used: number, right: string, width: number): Line {
  if (!right) return line;
  return [...line, { text: " ".repeat(Math.max(2, width - used - displayWidth(right))) }, dim(right)];
}

export function StatusLine({ input, width }: { input: StatusInput; width: number }) {
  return <LineText line={statusLine(input, width)} />;
}
