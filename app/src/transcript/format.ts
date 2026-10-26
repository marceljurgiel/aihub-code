/**
 * Pure formatters: one bridge event in, styled lines out (see the spec's
 * "Transcript" table). No React, no renderer; the lines go to a ScrollbackSink.
 * Every formatter fits its output into the terminal width it is given, and
 * strips terminal escapes from text that came from the model or a tool.
 */
import { homedir } from "node:os";
import { G } from "../glyphs";
import type { Line, Span } from "../scrollback";
import { palette } from "../theme";
import { lineWidth, sanitize, stripCR, truncate, truncateStart, wrapSpans, displayWidth } from "../width";
import type { CompactionEvent, DiffEvent, HeaderInfo, TodoItem, ToolCallEvent, ToolResultEvent, UndoPlan } from "./events";

const FIRST = "  "; // result rows hang under the call line:
const ELBOW = () => `${FIRST}${G.elbow} `; //   "  ⎿ " first row,
const MORE = "    "; //                           "    " the rest

const dim = (text: string): Span => ({ text, dim: true });
const red = (text: string): Span => ({ text, fg: palette.red });

/** The lines of untrusted text: no escapes, no CRLF leftovers (see stripCR). */
const linesOf = (text: string): string[] => text.split("\n").map((l) => sanitize(stripCR(l)));

/** One logical line of untrusted text: no escapes, no line breaks. */
const oneLine = (text: unknown): string => linesOf(String(text ?? "")).join(" ");

function prefixed(rows: Span[][]): Line[] {
  return rows.map((row, i) => [{ text: i === 0 ? ELBOW() : MORE }, ...row]);
}

// ── user prompt ───────────────────────────────────────────────────────────────

export function fmtUser(text: string, width: number): Line[] {
  const out: Line[] = [];
  sanitize(text)
    .split("\n")
    .forEach((logical, i) => {
      wrapSpans([{ text: logical }], Math.max(1, width - 2)).forEach((row, j) => {
        if (i === 0 && j === 0) out.push([{ text: ">", fg: palette.accent, bold: true }, { text: " " }, ...row]);
        else out.push(row.length ? [{ text: "  " }, ...row] : []);
      });
    });
  return out;
}

/** A typed `/command args`, dim, one logical line (the output follows it). */
export function fmtCommandEcho(text: string, width: number): Line[] {
  const one = sanitize(stripCR(text)).replace(/\s+/g, " ").trim();
  return wrapSpans([dim(`> ${one}`)], Math.max(1, width), { indent: "  " });
}

// ── tool calls ────────────────────────────────────────────────────────────────

const PATH_KEYS: Record<string, string> = {
  read_file: "path",
  edit_file: "path",
  write_file: "path",
  list_files: "directory",
};

/** The one argument worth showing next to the tool name. */
export function mainArg(ev: Pick<ToolCallEvent, "name" | "arguments">): { text: string; path: boolean } {
  const args = ev.arguments && typeof ev.arguments === "object" ? ev.arguments : {};
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const key = PATH_KEYS[ev.name];
  if (key) return { text: oneLine(str(key)), path: true };
  if (ev.name === "todo_write") return { text: "", path: false };
  if (ev.name === "search_files") {
    const q = str("content_query");
    return { text: oneLine(q ? `${str("pattern")} "${q}"` : str("pattern")), path: false };
  }
  if (ev.name === "run_terminal" || ev.name === "run_shell") {
    const [first = "", ...rest] = linesOf(str("command"));
    return { text: rest.length ? `${first} ${G.ellipsis}` : first, path: false };
  }
  const first = Object.values(args).find((v) => typeof v === "string" && v.trim() !== "");
  return { text: oneLine(first), path: false };
}

export function fmtToolCall(ev: ToolCallEvent, width: number): Line[] {
  const name = ev.name === "todo_write" ? "todos" : oneLine(ev.name);
  const arg = mainArg(ev);
  const room = width - 2 - displayWidth(name) - 1;
  let argText = arg.text;
  if (room < 2) argText = "";
  else if (displayWidth(argText) > room) argText = arg.path ? truncateStart(argText, room) : truncate(argText, room);
  const shownName = truncate(name, Math.max(1, width - 2));
  const line: Line = [{ text: G.bullet, fg: palette.accent }, { text: " " }, { text: shownName, bold: true }];
  if (argText) line.push({ text: ` ${argText}` });
  return [line];
}

// ── tool results ──────────────────────────────────────────────────────────────

const EXIT = /\n?\[Exit: ([^\]]*)\]\s*$/;
const FAILURE_TAG = /^\[(?:[\w ]+ )?Error\]/;

const firstLine = (text: string): string => linesOf(text).find((l) => l.trim() !== "") ?? "";

function oneRow(spans: Span[], width: number, text: string): Line[] {
  return [[{ text: ELBOW() }, ...spans, { text: truncate(text, Math.max(1, width - displayWidth(ELBOW()))) }]];
}

/** Rows of a shell result: the last 3 output lines, the exit code on the last.
 * The `[exit N]` tag shrinks when the terminal is narrow, and goes on a row of
 * its own when the output line would be left with no room. */
function shellRows(result: string, exit: string, width: number): Line[] {
  const lines = linesOf(result.replace(EXIT, ""))
    .filter((l) => l.trim() !== "")
    .slice(-3);
  const code = oneLine(exit.trim());
  const style = (text: string): Span => (code === "0" ? dim(text) : red(text));
  const room = Math.max(1, width - 4);
  const rows: Span[][] = lines.map((l) => [{ text: truncate(l, room) }]);
  const tags = [`  [exit ${code}]`, ` [exit ${code}]`];
  const last = rows[rows.length - 1];
  if (last) {
    const used = displayWidth(lines[lines.length - 1]!);
    const fits = tags.find((t) => displayWidth(t) + Math.min(used, 4) <= room);
    if (fits) {
      last[0]!.text = truncate(lines[lines.length - 1]!, Math.max(1, room - displayWidth(fits)));
      last.push(style(fits));
      return prefixed(rows);
    }
  }
  // No output, or under 4 columns left beside it: the tag alone on a row,
  // as `[N]` when even that is too wide.
  const alone = displayWidth(`[exit ${code}]`) <= room ? `[exit ${code}]` : `[${code}]`;
  rows.push([style(truncate(alone, room))]);
  return prefixed(rows);
}

function readSummary(result: string): string {
  if (result.trim() === "(empty file)") return "empty file";
  const shown = result.split("\n").filter((l) => /^\s*\d+\t/.test(l)).length;
  const page = /\[lines \d+-\d+ of (\d+)/.exec(result);
  return page ? `${shown} lines (of ${page[1]})` : `${shown} lines`;
}

export function fmtToolResult(ev: ToolResultEvent, width: number): Line[] {
  const result = String(ev.result ?? "");
  if (ev.denied) {
    const text = result.startsWith("Plan mode:") ? "denied (plan mode)" : "denied";
    return [[{ text: ELBOW() }, { text, fg: palette.yellow }]];
  }
  if (ev.name === "run_terminal" || ev.name === "run_shell") {
    const m = EXIT.exec(result);
    if (m) return shellRows(result, m[1]!, width);
  }
  if (ev.error || FAILURE_TAG.test(result.trimStart())) {
    const text = firstLine(result) || oneLine(ev.error);
    return [[{ text: ELBOW() }, red(truncate(text, Math.max(1, width - displayWidth(ELBOW()))))]];
  }
  switch (ev.name) {
    case "edit_file":
    case "write_file":
    case "todo_write":
      return []; // the code_diff / code_todos event shows the outcome
    case "read_file":
      return oneRow([], width, readSummary(result));
    case "search_files":
    case "list_files": {
      if (/^\[(Search\] )?No files/.test(result.trim())) return oneRow([], width, "no matches");
      const n = result.split("\n").filter((l) => l.trim() !== "").length;
      return oneRow([], width, `${n} lines`);
    }
  }
  const lines = linesOf(result).filter((l) => l.trim() !== "");
  if (lines.length === 0) return oneRow([], width, "(no output)");
  return oneRow([], width, lines.length === 1 ? lines[0]! : `${lines.length} lines`);
}

// ── diffs ─────────────────────────────────────────────────────────────────────

export function fmtDiff(diff: DiffEvent, width: number, max = 12): Line[] {
  const room = Math.max(1, width - 4);
  const raw = linesOf(diff.text);
  const hasHeader = raw[0]?.startsWith("--- ") && raw[1]?.startsWith("+++ ");
  const body = hasHeader ? raw.slice(2) : raw;
  const changed = body.filter((l) => l.startsWith("+") || l.startsWith("-"));
  const label: Span[][] = diff.label ? [[dim(truncate(oneLine(diff.label), room))]] : [];
  if (changed.length === 0) {
    if (label.length) return prefixed(label);
    if (diff.error) return prefixed([[red(truncate(firstLine(diff.error), room))]]);
    const summary = firstLine(diff.text);
    // No hunks, but text: the engine's "binary or large file" summary.
    if (summary && !hasHeader && !body.some((l) => l.startsWith("@@"))) return prefixed([[dim(truncate(summary, room))]]);
    return prefixed([[dim("no changes")]]);
  }
  const total = Math.max(changed.length, (diff.added ?? 0) + (diff.removed ?? 0));
  const shown = changed.slice(0, Math.max(1, max - label.length));
  const rows: Span[][] = [
    ...label,
    ...shown.map((l) => [{ text: truncate(l, room), fg: l.startsWith("+") ? palette.green : palette.red }]),
  ];
  if (total > shown.length) rows.push([dim(`${G.ellipsis} +${total - shown.length} lines`)]);
  return prefixed(rows);
}

// ── the rest ──────────────────────────────────────────────────────────────────

export function fmtTodos(todos: TodoItem[], width = Infinity): Line[] {
  if (todos.length === 0) return prefixed([[dim("no todos")]]);
  const room = Number.isFinite(width) ? Math.max(1, width - 4) : Infinity;
  return prefixed(
    todos.map((t) => {
      const done = t.status === "completed";
      const text = truncate(oneLine(t.content), room - displayWidth(G.boxOpen) - 1);
      return [{ text: `${done ? G.boxDone : G.boxOpen} ${text}`, bold: t.status === "in_progress", dim: done }];
    }),
  );
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** `limit` is the model's context size: with it the counts become percentages. */
export function fmtCompaction(ev: CompactionEvent, limit?: number): Line[] {
  const amount = limit
    ? `${Math.round((100 * ev.before) / limit)}% ${G.arrow} ${Math.round((100 * ev.after) / limit)}%`
    : `${tokens(ev.before)} ${G.arrow} ${tokens(ev.after)} tokens`;
  return [[dim(`${G.diamond} context compacted ${amount} (${oneLine(ev.method)})`)]];
}

export function fmtError(msg: string, width: number): Line[] {
  return linesOf(msg)
    .flatMap((l, i) => wrapSpans([red(i === 0 ? `${G.cross} ${l}` : `  ${l}`)], width, { indent: "  " }));
}

export function fmtNote(text: string, width = Infinity): Line[] {
  return linesOf(text)
    .flatMap((l) => (Number.isFinite(width) ? wrapSpans([dim(l)], width) : [[dim(l)]]));
}

/** `── new session ──────`: a dim rule with a label, one cell short of the width. */
export function fmtDivider(text: string, width: number): Line[] {
  const label = ` ${truncate(oneLine(text), Math.max(1, width - 8))} `;
  const tail = Math.max(2, width - 1 - 2 - displayWidth(label));
  return [[dim(`${G.h}${G.h}${label}${G.h.repeat(tail)}`)]];
}

const fileCount = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
const MAX_UNDO_FILES = 12;
const MAX_NAMED = 5;

/** What `/undo` would change: restore, delete, and what it cannot do. */
export function fmtUndoPlan(plan: UndoPlan, width: number): Line[] {
  const rows: [string, string][] = [
    ...plan.restore.map((f): [string, string] => ["restore", f]),
    ...plan.delete.map((f): [string, string] => ["delete", f]),
  ];
  const out: Line[] = [[{ text: rows.length === 0 ? "the last turn changed no files" : `the last turn changed ${fileCount(rows.length)}:` }]];
  for (const [verb, file] of rows.slice(0, MAX_UNDO_FILES)) {
    const head = `  ${verb.padEnd(7)}  `;
    out.push([dim(head), { text: truncateStart(oneLine(file), Math.max(1, width - displayWidth(head))) }]);
  }
  if (rows.length > MAX_UNDO_FILES) out.push([dim(`  ${G.ellipsis} ${rows.length - MAX_UNDO_FILES} more`)]);
  return [...out, ...named("shell commands are not undone", plan.shell_not_reverted, width), ...named("can't be put back safely", plan.skipped, width)];
}

/** The files that changed after the turn; `hint` adds the way to override. */
export function fmtUndoConflicts(plan: UndoPlan, width: number, hint = true): Line[] {
  return [
    ...named("these changed after the turn", plan.conflicts, width),
    ...(hint ? fmtNote("/undo force undoes them anyway (your newer changes are lost)", width) : []),
  ];
}

function named(label: string, items: string[], width: number): Line[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, MAX_NAMED).map(oneLine).join(", ");
  const more = items.length > MAX_NAMED ? ` and ${items.length - MAX_NAMED} more` : "";
  return wrapSpans([{ text: `${label}: ${shown}${more}` }], width);
}

/** `restore 1 file, delete 2 files` (before) or `restored 1 file, deleted 2 files` (after). */
export function undoSummary(plan: UndoPlan, done: boolean): string {
  const parts = [
    plan.restore.length ? `${done ? "restored" : "restore"} ${fileCount(plan.restore.length)}` : "",
    plan.delete.length ? `${done ? "deleted" : "delete"} ${fileCount(plan.delete.length)}` : "",
  ].filter(Boolean);
  if (parts.length) return parts.join(", ");
  return done ? "the last turn is out of the history" : "no file changes";
}

function homeRelative(root: string, home: string): string {
  if (root === home) return "~";
  for (const sep of ["/", "\\"]) if (root.startsWith(home + sep)) return "~" + root.slice(home.length);
  return root;
}

export function fmtHeader(info: HeaderInfo, width: number): Line[] {
  const head = ` aihub-code ${oneLine(info.version)} ${G.sep} ${oneLine(info.model)} ${G.sep} ${oneLine(info.mode)} ${G.sep} `;
  const nameWidth = " aihub-code".length;
  let path = oneLine(homeRelative(info.root, info.home ?? homedir()));
  let tail = info.branch ? ` (${oneLine(info.branch)})` : "";
  const fixed = displayWidth(head);
  // The path gives way first, then the branch; the line never wraps.
  if (fixed + displayWidth(path) + displayWidth(tail) > width) {
    if (width - fixed - displayWidth(tail) >= 4) path = truncateStart(path, width - fixed - displayWidth(tail));
    else {
      tail = "";
      path = width - fixed >= 4 ? truncateStart(path, width - fixed) : "";
    }
  }
  const line: Line = [
    { text: " " },
    { text: "aihub-code", bold: true, fg: palette.accent },
    dim(head.slice(nameWidth) + path + tail),
  ];
  if (lineWidth(line) <= width) return [line];
  // Not even the fixed part fits: cut the whole line.
  const cut = truncate(head.slice(nameWidth), Math.max(0, width - nameWidth));
  return [[{ text: " " }, { text: "aihub-code".slice(0, Math.max(0, width - 1)), bold: true, fg: palette.accent }, dim(cut)]];
}
