/** The line above the box while a turn runs: spinner, what is happening, seconds. */
import { G } from "../glyphs";
import type { Line } from "../scrollback";
import { palette } from "../theme";
import { lineWidth, splitAtWidth, truncate } from "../width";
import { LineText } from "./LineText";

const FRAME_MS = 80;

/** `4s`, then `1m 05s`. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

export function activityLine(
  activity: { label: string; since: number },
  now: number,
  width: number,
  opts: { interruptible: boolean },
): Line {
  const spin = G.spinner[Math.floor(Math.max(0, now) / FRAME_MS) % G.spinner.length]!;
  const elapsed = ` ${fmtElapsed(now - activity.since)}`;
  const build = (label: string, hint: boolean): Line => [
    { text: " " },
    { text: spin, fg: palette.accent },
    { text: ` ${label}` },
    { text: hint ? `${elapsed} · esc to interrupt` : elapsed, dim: true },
  ];
  // The label gives way first: the clock and the hint are what the user needs.
  for (const hint of opts.interruptible ? [true, false] : [false]) {
    const fixed = lineWidth(build("", hint));
    if (fixed + 1 < width) {
      const line = build(truncate(activity.label, width - fixed), hint);
      if (lineWidth(line) <= width) return line;
    }
  }
  return splitAtWidth(build(activity.label, false), width)[0] ?? [];
}

export function ActivityLine({
  activity,
  now,
  width,
  interruptible,
}: {
  activity: { label: string; since: number };
  now: number;
  width: number;
  interruptible: boolean;
}) {
  return <LineText line={activityLine(activity, now, width, { interruptible })} />;
}
