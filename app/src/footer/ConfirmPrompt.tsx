/**
 * A yes/no question in place of the input box (`/undo`): one line of detail,
 * the question, and the keys: y says yes; n, Enter, Esc and Ctrl+C say no.
 * Like the permission prompt it ignores keys for a moment after it appears,
 * so a typed-ahead letter cannot answer it.
 */
import { useKeyboard } from "@opentui/react";
import { useRef } from "react";
import { colour } from "../scrollback";
import type { ConfirmState } from "../session/controller";
import { palette } from "../theme";
import { sanitize, truncate } from "../width";
import { LineText } from "./LineText";
import { BOX_CHARS } from "./style";

export const CONFIRM_ROWS = 2;

export function ConfirmPrompt({
  confirm,
  width,
  now,
  guardMs,
  onAnswer,
}: {
  confirm: ConfirmState;
  width: number;
  now: () => number;
  guardMs: number;
  onAnswer: (yes: boolean) => void;
}) {
  const inner = Math.max(1, width - 4);
  const shownAt = useRef(now());
  const live = useRef(onAnswer);
  live.current = onAnswer;

  useKeyboard((key) => {
    key.preventDefault();
    if (now() - shownAt.current < guardMs) return;
    if (!key.ctrl && !key.meta && key.sequence?.toLowerCase() === "y") live.current(true);
    else if (
      (key.ctrl && key.name === "c") ||
      key.name === "escape" ||
      key.name === "return" ||
      key.name === "kpenter" ||
      key.name === "linefeed" ||
      (!key.ctrl && !key.meta && key.sequence?.toLowerCase() === "n")
    )
      live.current(false);
  });

  return (
    <box
      border
      customBorderChars={BOX_CHARS}
      borderColor={colour(palette.yellow)}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      width={width}
      height={CONFIRM_ROWS + 2}
      flexShrink={0}
    >
      <LineText line={[{ text: truncate(sanitize(confirm.detail), inner), dim: true }]} />
      <LineText line={[{ text: truncate(sanitize(confirm.question), inner), bold: true }]} />
    </box>
  );
}
