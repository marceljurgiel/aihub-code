/** Command suggestions under the box while the first word starts with "/". */
import type { Line } from "../scrollback";
import { palette } from "../theme";
import { displayWidth, truncate } from "../width";
import { LineText } from "./LineText";

export interface SlashCommand {
  /** Without the slash. */
  name: string;
  hint: string;
}

/** The commands whose name starts with what is typed; only while the cursor is
 * still in the command word (no space yet). */
export function slashMatches(text: string, commands: readonly SlashCommand[]): SlashCommand[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const typed = text.slice(1).toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(typed));
}

export const MAX_SUGGESTIONS = 5;

/** The rows to draw: a window of at most `max` (MAX_SUGGESTIONS) around the highlight. */
export function suggestWindow<T>(items: readonly T[], highlight: number, max = MAX_SUGGESTIONS): { rows: T[]; start: number } {
  const start = Math.max(0, Math.min(highlight - max + 1, items.length - max));
  return { rows: items.slice(start, start + max), start };
}

export function suggestLine(c: SlashCommand, selected: boolean, nameWidth: number, width: number): Line {
  const name = `/${c.name}`.padEnd(nameWidth);
  const room = Math.max(0, width - 3 - displayWidth(name) - 2);
  const hint = room > 3 ? truncate(c.hint, room) : "";
  return [
    { text: "  " },
    { text: truncate(name, Math.max(1, width - 2)), fg: selected ? palette.accent : undefined, bold: selected },
    ...(hint ? [{ text: `  ${hint}`, dim: true }] : []),
  ];
}

export function SlashSuggest({ items, highlight, width, maxRows = MAX_SUGGESTIONS }: { items: readonly SlashCommand[]; highlight: number; width: number; maxRows?: number }) {
  const { rows, start } = suggestWindow(items, highlight, maxRows);
  const nameWidth = Math.max(...items.map((c) => c.name.length + 1));
  return (
    <box flexDirection="column" flexShrink={0}>
      {rows.map((c, i) => (
        <LineText key={c.name} line={suggestLine(c, start + i === highlight, nameWidth, width)} />
      ))}
    </box>
  );
}
