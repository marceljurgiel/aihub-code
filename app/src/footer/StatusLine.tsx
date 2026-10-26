/** The dim line under the box: mode · model · context · what the keys do. */
import type { Line, Span } from "../scrollback";
import { modeColor, palette } from "../theme";
import { displayWidth, splitAtWidth, truncate } from "../width";
import { LineText } from "./LineText";

export interface StatusInput {
  mode: string;
  model: string;
  ctx: { used: number; limit: number };
  queued: number;
  /** The key hints when nothing replaces them (default DEFAULT_HINTS). */
  hints?: string[];
  /** Replaces the key hints (a question, or the keys of a prompt). */
  hint?: { text: string; warn?: boolean } | null;
}

const SEP = " · ";
const dim = (text: string): Span => ({ text, dim: true });

export const DEFAULT_HINTS = ["shift+tab mode", "/help"];
export const CHAT_HINTS = ["/agent switch", "/help"];

/** Left to right; the width decides how many of the tail segments survive. */
export function statusLine(s: StatusInput, width: number): Line {
  const ctxPct = s.ctx.limit > 0 ? `ctx ${Math.min(100, Math.round((s.ctx.used / s.ctx.limit) * 100))}%` : null;
  const right = s.queued > 0 ? `queued ${s.queued}` : "";
  const hints: Span[][] = s.hint ? [[s.hint.warn ? { text: s.hint.text, fg: palette.yellow } : dim(s.hint.text)]] : (s.hints ?? DEFAULT_HINTS).map((h) => [dim(h)]);
  const model = s.model || "no model";
  const segs = (m: string, nHints: number): Span[][] => [
    [{ text: s.mode, fg: modeColor(s.mode), bold: true }],
    [dim(m)],
    ...(ctxPct ? [[dim(ctxPct)]] : []),
    ...hints.slice(0, nHints),
  ];
  const widthOf = (parts: Span[][]) => 1 + parts.reduce((w, p, i) => w + (i ? SEP.length : 0) + p.reduce((x, sp) => x + displayWidth(sp.text), 0), 0);
  const join = (parts: Span[][]): Line => [{ text: " " }, ...parts.flatMap((p, i) => (i ? [dim(SEP), ...p] : p))];

  // Drop hints from the end, then cut the model name, until it fits beside "queued N".
  const reserve = right ? displayWidth(right) + 2 : 0;
  let m = model;
  for (let n = hints.length; n >= 0; n--) {
    const parts = segs(m, n);
    if (widthOf(parts) + reserve <= width) return withRight(join(parts), widthOf(parts), right, width);
  }
  const bare = segs(m, 0);
  const fixed = widthOf(bare) - displayWidth(m);
  m = truncate(model, Math.max(1, width - reserve - fixed));
  const parts = segs(m, 0);
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
