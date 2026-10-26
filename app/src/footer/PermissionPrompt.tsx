/**
 * The permission prompt: replaces the input box while the engine waits for a
 * yes or no. Number keys or arrows + Enter choose; option 3 turns into an
 * input for what the model should do instead. Every answer carries the id of
 * the prompt that was on screen, so a late answer can never go to a newer one.
 *
 * The options are numbered 1, 2, 3 as shown: yes; yes and remember (only
 * offered when the engine suggests a rule); no with a note. Without a rule
 * there are two, and the digit keys follow the displayed numbers.
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
export function permissionLayout(p: PermissionState, width: number, cursor: number, editing: boolean): PermissionLayout {
  const title: Line = [{ text: permissionTitle(p, width), bold: true }];
  let diff: Line[] = [];
  if (p.diff) {
    diff = fmtDiff(p.diff, width, MAX_DIFF_ROWS);
    if (diff.length > MAX_DIFF_ROWS) diff = fmtDiff(p.diff, width, MAX_DIFF_ROWS - 1);
  }
  const labels: { kind: PermissionChoiceKind; label: string }[] = [{ kind: "yes", label: "Yes" }];
  if (p.suggestedRule) {
    const lead = "Yes, and don't ask again for ";
    const tail = " (this project)";
    const room = width - 5 - lead.length - tail.length;
    const rule = ruleText(p);
    labels.push({ kind: "always", label: room >= 8 ? `${lead}${truncate(rule, room)}${tail}` : truncate(`${lead}${rule}${tail}`, width - 5) });
  }
  labels.push({ kind: "note", label: "No, and tell the model what to do instead" });
  const options = labels.map(({ kind, label }, i) => {
    const on = i === cursor;
    const n = i + 1;
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
  /** Keys in the first moments are ignored: typed-ahead Enter must not approve. */
  guardMs: number;
  /** The inline input opened or closed (the status line's hint follows). */
  onEditing?: (editing: boolean) => void;
  /** Ctrl+C: the footer interrupts the turn (and remembers that it did). */
  onInterrupt?: () => void;
}

export function PermissionPrompt({ controller, permission: p, width, now, guardMs, onEditing, onInterrupt }: PermissionPromptProps) {
  const inner = Math.max(1, width - 4);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const layout = permissionLayout(p, inner, cursor, editing);
  const shownAt = useRef(now());
  // Always the prompt on screen, read at key time (keys can outrun renders).
  const live = useRef({ p, cursor: 0, editing: false, offered: layout.options.map((o) => o.kind) });
  live.current.p = p;
  live.current.offered = layout.options.map((o) => o.kind);
  useEffect(() => {
    shownAt.current = now();
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
      move(live.current.offered.indexOf("note"));
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
    if (now() - shownAt.current < guardMs) {
      key.preventDefault();
      return;
    }
    const last = L.offered.length - 1;
    if (key.name === "up") move(L.cursor <= 0 ? last : L.cursor - 1);
    else if (key.name === "down") move(L.cursor >= last ? 0 : L.cursor + 1);
    else if (key.name === "return" || key.name === "kpenter" || key.name === "linefeed") choose(L.offered[L.cursor]!);
    else if (key.name === "escape") controller.answer({ no: null }, L.p.permissionId);
    else if (!key.ctrl && !key.meta && /^[1-9]$/.test(key.sequence ?? "")) {
      const kind = L.offered[Number(key.sequence) - 1];
      if (kind) choose(kind);
    }
    key.preventDefault();
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
