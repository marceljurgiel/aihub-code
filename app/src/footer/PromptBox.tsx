/** The input box: a rounded border, the caret, a textarea that grows with its text. */
import type { TextareaRenderable } from "@opentui/core";
import type { MutableRefObject } from "react";
import { colour } from "../scrollback";
import { modeColor } from "../theme";
import { LineText } from "./LineText";
import { BOX_CHARS, FG, GREY, TRANSPARENT } from "./style";

export const MAX_INPUT_ROWS = 8;

/** Enter sends; Shift+Enter, Alt+Enter and Ctrl+J add a line (Ctrl+J is what
 * terminals without the kitty keyboard protocol can send for it). */
export const PROMPT_KEYS = [
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "kpenter", shift: true, action: "newline" as const },
  { name: "return", meta: true, action: "newline" as const },
  { name: "linefeed", action: "newline" as const },
  { name: "j", ctrl: true, action: "newline" as const },
];

export interface PromptBoxProps {
  width: number;
  mode: string;
  /** Visible text rows (the footer's count, 1..MAX_INPUT_ROWS). */
  rows: number;
  inputRef: MutableRefObject<TextareaRenderable | null>;
  initialValue: string;
  onContentChange: () => void;
  onSubmit: () => void;
}

export function PromptBox({ width, mode, rows, inputRef, initialValue, onContentChange, onSubmit }: PromptBoxProps) {
  // In plan and auto the box takes the mode's colour: the mode is hard to miss.
  const border = mode === "build" ? GREY() : colour(modeColor(mode));
  return (
    <box
      border
      customBorderChars={BOX_CHARS}
      borderColor={border}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      width={width}
      height={rows + 2}
      flexShrink={0}
    >
      <box width={2} flexShrink={0}>
        <LineText line={[{ text: ">", fg: modeColor(mode), bold: true }, { text: " " }]} />
      </box>
      <textarea
        ref={(el: TextareaRenderable | null) => {
          inputRef.current = el;
        }}
        focused
        initialValue={initialValue}
        width={Math.max(1, width - 6)}
        height={rows}
        wrapMode="word"
        keyBindings={PROMPT_KEYS}
        textColor={FG()}
        focusedTextColor={FG()}
        backgroundColor={TRANSPARENT}
        focusedBackgroundColor={TRANSPARENT}
        placeholderColor={GREY()}
        onContentChange={onContentChange}
        onSubmit={onSubmit}
      />
    </box>
  );
}
