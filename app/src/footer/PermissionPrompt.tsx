/**
 * The permission prompt: replaces the input box while the engine waits for a
 * yes or no. Number keys or arrows + Enter choose; option 3 turns into an
 * input for what the model should do instead. Every answer carries the id of
 * the prompt that was on screen, so a late answer can never go to a newer one.
 *
 * The numbers never move: 1 yes; 2 yes and remember (only shown, and only a
 * key, when the engine suggests a rule); 3 no with a note. A "2" from habit
 * must never mean "remember" on one prompt and "no" on the next.
 *
 * Keys only count after a quiet moment: every key that arrives within
 * `guardMs` of the one before (or of the prompt's arrival) is dropped and
 * restarts the wait, and a key that does nothing (a letter) restarts it too.
 * So a follow-up being typed when the prompt replaces the input box (its
 * Enter, a digit in it) can never answer a prompt nobody has read. New-line
 * keys (Ctrl+J, Shift+Enter) never confirm.
 */
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { G } from "../glyphs";
import type { Line } from "../scrollback";
import { colour } from "../scrollback";
import type { Controller, PermissionState } from "../session/controller";
import { palette } from "../theme";
import { fmtDiff, mainArg } from "../transcript/format";
import { displayWidth, truncate, truncateStart, sanitize, stripCR } from "../width";
import { LineText } from "./LineText";
import { BOX_CHARS, FG, GREY, TRANSPARENT } from "./style";

const SHELL = new Set(["run_terminal", "run_shell"]);
export const MAX_DIFF_ROWS = 10;
export const EDIT_PLACEHOLDER = "Tell the model what to do instead";

/** "Run pytest -q?" / "Allow edit_file calc.py?", fitted to `width`. */
export function permissionTitle(p: Pick<PermissionState, "name" | "arguments">, width: number): string {
  const arg = mainArg(p);
  const name = sanitize(stripCR(p.name)).replace(/\n/g, " ");
  if (SHELL.has(p.name)) {
    const head = arg.text ? "Run " : "Run a command";
    return `${head}${truncate(arg.text, Math.max(1, width - head.length - 1))}?`;
  }
  const head = `Allow ${name}`;
  if (!arg.text) return `${truncate(head, Math.max(1, width - 1))}?`;
  const room = width - head.length - 2;
  if (room < 4) return `${truncate(head, Math.max(1, width - 1))}?`;
  return `${head} ${arg.path ? truncateStart(arg.text, room) : truncate(arg.text, room)}?`;
}

/** The rule as the engine will store it: `edit_file`, `run_terminal: git status`. */
function ruleText(p: PermissionState): string {
  const r = p.suggestedRule;
  if (!r) return "";
  const one = (t: string) => sanitize(stripCR(t)).replace(/\n/g, " ");
  return r.pattern ? `${one(r.tool)}: ${one(r.pattern)}` : one(r.tool);
}

export type PermissionChoiceKind = "yes" | "always" | "note";

export interface PermissionOption {
  /** The number shown, and the key that picks it. */
  n: number;
  kind: PermissionChoiceKind;
  line: Line;
}

export interface PermissionLayout {
  title: Line;
  diff: Line[];
  options: PermissionOption[];
  /** Width of the "❯ 3. " prefix, where the inline input starts (2 digits never occur). */
  prefixWidth: number;
  /** Rows inside the box. */
  rows: number;
}

/** What the prompt draws, row by row; `cursor` indexes `options`. In `editing`
 * mode the last option is only its prefix: the input goes after it. */
export function permissionLayout(p: PermissionState, width: number, cursor: number, editing: boolean, maxDiff = MAX_DIFF_ROWS): PermissionLayout {
  const title: Line = [{ text: permissionTitle(p, width), bold: true }];
  let diff: Line[] = [];
  const room = Math.min(MAX_DIFF_ROWS, maxDiff);
  if (p.diff && room > 0) {
    diff = fmtDiff(p.diff, width, room);
    if (diff.length > room) diff = fmtDiff(p.diff, width, room - 1);
  }
  const labels: { n: number; kind: PermissionChoiceKind; label: string }[] = [{ n: 1, kind: "yes", label: "Yes" }];
  if (p.suggestedRule) {
    const lead = "Yes, and don't ask again for ";
    const tail = " (this project)";
    const room = width - 5 - lead.length - tail.length;
    const rule = ruleText(p);
    labels.push({ n: 2, kind: "always", label: room >= 8 ? `${lead}${truncate(rule, room)}${tail}` : truncate(`${lead}${rule}${tail}`, width - 5) });
  }
  labels.push({ n: 3, kind: "note", label: "No, and tell the model what to do instead" });
  const options = labels.map(({ n, kind, label }, i) => {
    const on = i === cursor;
    const prefix = `${on ? G.pointer : " "} ${n}. `;
    const text = editing && kind === "note" && on ? "" : truncate(label, Math.max(1, width - displayWidth(prefix)));
    const line: Line = [
      { text: prefix, fg: on ? palette.yellow : undefined, bold: on },
      ...(text ? [{ text, bold: on }] : []),
    ];
    return { n, kind, line };
  });
  const prefixWidth = displayWidth(`${G.pointer} 3. `);
  return { title, diff, options, prefixWidth, rows: 1 + diff.length + options.length };
}

export interface PermissionPromptProps {
  controller: Controller;
  permission: PermissionState;
  width: number;
  now: () => number;
  /** The quiet a key needs before it counts (see the top of this file). */
  guardMs: number;
  /** The inline input opened or closed (the status line's hint follows). */
  onEditing?: (editing: boolean) => void;
  /** Ctrl+C: the footer interrupts the turn (and remembers that it did). */
  onInterrupt?: () => void;
  /** Diff rows the terminal leaves room for (default: MAX_DIFF_ROWS). */
  maxDiff?: number;
}

export function PermissionPrompt({ controller, permission: p, width, now, guardMs, onEditing, onInterrupt, maxDiff }: PermissionPromptProps) {
  const inner = Math.max(1, width - 4);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const layout = permissionLayout(p, inner, cursor, editing, maxDiff);
  // The last key (or the prompt's arrival): the quiet window counts from here.
  const lastKey = useRef(now());
  // Always the prompt on screen, read at key time (keys can outrun renders).
  const live = useRef({ p, cursor: 0, editing: false, options: layout.options });
  live.current.p = p;
  live.current.options = layout.options;
  useEffect(() => {
    lastKey.current = now();
    return () => onEditing?.(false);
  }, [p.permissionId, p.requestId]);

  const move = (to: number) => {
    live.current.cursor = to;
    setCursor(to);
  };
  const edit = (on: boolean) => {
    live.current.editing = on;
    setEditing(on);
    onEditing?.(on);
  };
  const choose = (kind: PermissionChoiceKind) => {
    const id = live.current.p.permissionId;
    if (kind === "yes") controller.answer("yes", id);
    else if (kind === "always") controller.answer("always", id);
    else {
      move(live.current.options.findIndex((o) => o.kind === "note"));
      edit(true);
    }
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (onInterrupt) onInterrupt();
      else controller.cancel();
      return;
    }
    const L = live.current;
    if (L.editing) {
      // The input owns the keys; Esc steps back to the list.
      if (key.name === "escape") {
        key.preventDefault();
        edit(false);
      }
      return;
    }
    key.preventDefault();
    const t = now();
    const early = t - lastKey.current < guardMs;
    const last = L.options.length - 1;
    const plain = !key.ctrl && !key.meta && !key.shift;
    const digit = plain && /^[1-9]$/.test(key.sequence ?? "") ? L.options.find((o) => o.n === Number(key.sequence)) : undefined;
    // What this key would do. Ctrl+J ("linefeed", or j with ctrl) and
    // Shift+Enter add a line in the input box: here they do nothing.
    const act =
      key.name === "up" ? () => move(L.cursor <= 0 ? last : L.cursor - 1)
      : key.name === "down" ? () => move(L.cursor >= last ? 0 : L.cursor + 1)
      : plain && (key.name === "return" || key.name === "kpenter") ? () => choose(L.options[L.cursor]!.kind)
      : key.name === "escape" ? () => controller.answer({ no: null }, L.p.permissionId)
      : digit ? () => choose(digit.kind)
      : null;
    if (early || !act) {
      lastKey.current = t; // still typing: the wait starts again
      return;
    }
    act();
  });

  // The input's text, tracked by hand: its submit event's argument is typed
  // differently across OpenTUI's own declarations.
  const note = useRef("");
  const onSubmit = () => {
    if (!live.current.editing) return;
    const value = note.current.trim();
    controller.answer({ no: value === "" ? null : value }, live.current.p.permissionId);
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
      height={layout.rows + 2}
      flexShrink={0}
    >
      <LineText line={layout.title} />
      {layout.diff.map((l, i) => (
        <LineText key={`d${i}`} line={l} />
      ))}
      {layout.options.map((o) =>
        editing && o.kind === "note" ? (
          <box key="edit" flexDirection="row" height={1} flexShrink={0}>
            <LineText line={o.line} />
            <input
              focused
              width={Math.max(1, inner - layout.prefixWidth)}
              placeholder={EDIT_PLACEHOLDER}
              placeholderColor={GREY()}
              textColor={FG()}
              focusedTextColor={FG()}
              backgroundColor={TRANSPARENT}
              focusedBackgroundColor={TRANSPARENT}
              onInput={(v: string) => {
                note.current = v;
              }}
              onSubmit={onSubmit}
            />
          </box>
        ) : (
          <LineText key={o.n} line={o.line} />
        ),
      )}
    </box>
  );
}
