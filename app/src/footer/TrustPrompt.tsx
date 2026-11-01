/**
 * Start-up's "do you trust this folder?" in place of the input box, as Claude
 * Code asks it: 1 yes (remembered), 2 no (aihub-code leaves). Arrows + Enter,
 * the numbers, y / n; Esc and Ctrl+C say no. Like the other prompts it drops
 * keys for a moment after it appears, so a typed-ahead Enter can't answer it.
 */
import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";
import { G } from "../glyphs";
import { colour, type Line } from "../scrollback";
import { palette } from "../theme";
import { sanitize, truncate, truncateStart } from "../width";
import { LineText } from "./LineText";
import { BOX_CHARS } from "./style";

export const TRUST_ROWS = 6;
const OPTIONS = ["Yes, I trust this folder", "No, exit"];

export function TrustPrompt({
  dir,
  width,
  now,
  guardMs,
  onAnswer,
}: {
  dir: string;
  width: number;
  now: () => number;
  guardMs: number;
  onAnswer: (yes: boolean) => void;
}) {
  const inner = Math.max(1, width - 4);
  const shownAt = useRef(now());
  const live = useRef(onAnswer);
  live.current = onAnswer;
  const [cursor, setCursor] = useState(0);
  const at = useRef(0);
  at.current = cursor;

  useKeyboard((key) => {
    key.preventDefault();
    if (now() - shownAt.current < guardMs) return;
    const ch = !key.ctrl && !key.meta ? key.sequence?.toLowerCase() : undefined;
    if (key.name === "up" || key.name === "down" || ch === "k" || ch === "j") {
      setCursor((c) => (c === 0 ? 1 : 0));
    } else if (key.name === "return" || key.name === "kpenter") {
      live.current(at.current === 0);
    } else if (ch === "1" || ch === "y") {
      live.current(true);
    } else if (ch === "2" || ch === "n" || key.name === "escape" || (key.ctrl && key.name === "c")) {
      live.current(false);
    }
  });

  const option = (i: number): Line => {
    const on = i === cursor;
    const prefix = `${on ? G.pointer : " "} ${i + 1}. `;
    return [
      { text: prefix, fg: on ? palette.accent : undefined, bold: on },
      { text: truncate(OPTIONS[i]!, Math.max(1, inner - prefix.length)), bold: on },
    ];
  };

  return (
    <box
      border
      customBorderChars={BOX_CHARS}
      borderColor={colour(palette.yellow)}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      width={width}
      height={TRUST_ROWS + 2}
      flexShrink={0}
    >
      <LineText line={[{ text: truncate("Do you trust the files in this folder?", inner), bold: true }]} />
      <LineText line={[{ text: truncateStart(sanitize(dir), inner), fg: palette.accent }]} />
      <LineText line={[{ text: truncate("aihub-code may read, edit and run files here,", inner), dim: true }]} />
      <LineText line={[{ text: truncate("and follows the project's AGENTS.md or CLAUDE.md.", inner), dim: true }]} />
      <LineText line={option(0)} />
      <LineText line={option(1)} />
    </box>
  );
}
