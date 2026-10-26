/**
 * A list to choose from, in the footer: models, sessions. Type to filter,
 * ↑↓ move, Enter picks, Esc cancels. At most 8 rows show; the box keeps its
 * height while the filter narrows the list, so the footer does not jump.
 */
import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";
import { G } from "../glyphs";
import type { Line } from "../scrollback";
import { colour } from "../scrollback";
import type { PickerItem, PickerState } from "../session/controller";
import { palette } from "../theme";
import { sanitize, stripCR, truncate } from "../width";
import { LineText } from "./LineText";
import { BOX_CHARS, FG, GREY, TRANSPARENT } from "./style";

export const MAX_PICKER_ROWS = 8;
const oneLine = (t: string) => sanitize(stripCR(t)).replace(/\n/g, " ");

export interface PickerLayout {
  matches: PickerItem[];
  rows: Line[];
  /** The scroll position to carry into the next call. */
  top: number;
  cursor: number;
  summary: string | null;
}

/** Rows a picker with `n` items always shows (not the matches: steady height). */
export const pickerRowCount = (n: number): number => Math.min(MAX_PICKER_ROWS, Math.max(1, n));

/** Rows inside the box: title, filter line, the list, a count when it scrolls. */
export const pickerInnerRows = (n: number): number => 2 + pickerRowCount(n) + (n > MAX_PICKER_ROWS ? 1 : 0);

export function pickerLayout(items: readonly PickerItem[], filter: string, cursor: number, top: number, width: number): PickerLayout {
  const words = oneLine(filter).toLowerCase().split(/\s+/).filter(Boolean);
  const labelOf = (i: PickerItem) => oneLine(i.label);
  const matches = items.filter((i) => {
    const hay = `${labelOf(i)} ${oneLine(i.id)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const V = pickerRowCount(items.length);
  const at = Math.max(0, Math.min(cursor, matches.length - 1));
  let from = Math.max(0, Math.min(top, Math.max(0, matches.length - V)));
  if (at < from) from = at;
  else if (at >= from + V) from = at - V + 1;
  const rows: Line[] = matches.slice(from, from + V).map((it, i) => {
    const on = from + i === at;
    return [
      { text: on ? `${G.pointer} ` : "  ", fg: on ? palette.accent : undefined, bold: on },
      { text: truncate(labelOf(it), Math.max(1, width - 2)), bold: on },
    ];
  });
  if (matches.length === 0) rows.push([{ text: items.length === 0 ? "nothing to choose from" : "no match", dim: true }]);
  while (rows.length < V) rows.push([]);
  return { matches, rows, top: from, cursor: at, summary: items.length > MAX_PICKER_ROWS ? `${matches.length} of ${items.length}` : null };
}

export function Picker({
  picker,
  width,
  onPick,
}: {
  picker: PickerState;
  width: number;
  onPick: (id: string | null) => void;
}) {
  const inner = Math.max(1, width - 4);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const top = useRef(0);
  const layout = pickerLayout(picker.items, filter, cursor, top.current, inner);
  top.current = layout.top;
  const live = useRef({ matches: layout.matches, cursor: layout.cursor, onPick });
  live.current = { matches: layout.matches, cursor: layout.cursor, onPick };

  useKeyboard((key) => {
    const L = live.current;
    if ((key.ctrl && key.name === "c") || key.name === "escape") {
      key.preventDefault();
      L.onPick(null);
      return;
    }
    const n = L.matches.length;
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      if (n === 0) return;
      const next = key.name === "up" ? (L.cursor + n - 1) % n : (L.cursor + 1) % n;
      L.cursor = next;
      setCursor(next);
    } else if (key.name === "return" || key.name === "kpenter" || key.name === "linefeed") {
      key.preventDefault();
      const chosen = L.matches[L.cursor];
      if (chosen) L.onPick(chosen.id);
    }
  });

  return (
    <box
      border
      customBorderChars={BOX_CHARS}
      borderColor={colour(palette.accent)}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      width={width}
      height={pickerInnerRows(picker.items.length) + 2}
      flexShrink={0}
    >
      <LineText line={[{ text: truncate(oneLine(picker.title), inner), bold: true }]} />
      <box flexDirection="row" height={1} flexShrink={0}>
        <LineText line={[{ text: "> ", fg: palette.accent, bold: true }]} />
        <input
          focused
          width={Math.max(1, inner - 2)}
          placeholder="type to filter"
          placeholderColor={GREY()}
          textColor={FG()}
          focusedTextColor={FG()}
          backgroundColor={TRANSPARENT}
          focusedBackgroundColor={TRANSPARENT}
          onInput={(v: string) => {
            setFilter(v);
            setCursor(0);
            top.current = 0;
          }}
        />
      </box>
      {layout.rows.map((l, i) => (
        <LineText key={i} line={l} />
      ))}
      {layout.summary ? <LineText line={[{ text: `  ${layout.summary}`, dim: true }]} /> : null}
    </box>
  );
}
