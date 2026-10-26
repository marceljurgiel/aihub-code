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
import { lineWidth, sanitize, truncate, truncateStart, wrapSpans, displayWidth } from "../width";
import type { CompactionEvent, DiffEvent, HeaderInfo, TodoItem, ToolCallEvent, ToolResultEvent } from "./events";

const FIRST = "  "; // result rows hang under the call line:
const ELBOW = () => `${FIRST}${G.elbow} `; //   "  ⎿ " first row,
const MORE = "    "; //                           "    " the rest

const dim = (text: string): Span => ({ text, dim: true });
const red = (text: string): Span => ({ text, fg: palette.red });

/** One logical line of untrusted text: no escapes, no line breaks. */
const oneLine = (text: unknown): string => sanitize(String(text ?? "")).replace(/\n/g, " ");

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

// ── tool calls ────────────────────────────────────────────────────────────────

const PATH_KEYS: Record<string, string> = {
  read_file: "path",
  edit_file: "path",
  write_file: "path",
  list_files: "directory",
};

/** The one argument worth showing next to the tool name. */
function mainArg(ev: ToolCallEvent): { text: string; path: boolean } {
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
    const [first = "", ...rest] = sanitize(str("command")).split("\n");
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

const firstLine = (text: string): string => sanitize(text).split("\n").find((l) => l.trim() !== "") ?? "";

function oneRow(spans: Span[], width: number, text: string): Line[] {
  return [[{ text: ELBOW() }, ...spans, { text: truncate(text, Math.max(1, width - displayWidth(ELBOW()))) }]];
}

/** Rows of a shell result: the last 3 output lines, the exit code on the last. */
function shellRows(result: string, exit: string, width: number): Line[] {
  const body = result.replace(EXIT, "");
  const lines = sanitize(body)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-3);
  const ok = exit.trim() === "0";
  const tag: Span = ok ? dim(`  [exit ${exit.trim()}]`) : red(`  [exit ${exit.trim()}]`);
  const room = Math.max(1, width - 4);
  const rows: Span[][] = lines.map((l, i) => {
    const last = i === lines.length - 1;
    return [{ text: truncate(l, last ? Math.max(1, room - displayWidth(tag.text)) : room) }];
  });
  if (rows.length === 0) return [[{ text: ELBOW() }, { ...tag, text: tag.text.trimStart() }]];
  rows[rows.length - 1]!.push(tag);
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
  const lines = sanitize(result).split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return oneRow([], width, "(no output)");
  return oneRow([], width, lines.length === 1 ? lines[0]! : `${lines.length} lines`);
}

// ── diffs ─────────────────────────────────────────────────────────────────────

export function fmtDiff(diff: DiffEvent, width: number, max = 12): Line[] {
  const room = Math.max(1, width - 4);
  const raw = sanitize(diff.text).split("\n");
  const hasHeader = raw[0]?.startsWith("--- ") && raw[1]?.startsWith("+++ ");
  const body = hasHeader ? raw.slice(2) : raw;
  const changed = body.filter((l) => l.startsWith("+") || l.startsWith("-"));
  if (changed.length === 0) {
    if (diff.error) return prefixed([[red(truncate(firstLine(diff.error), room))]]);
    const summary = firstLine(diff.text);
    // No hunks, but text: the engine's "binary or large file" summary.
    if (summary && !hasHeader && !body.some((l) => l.startsWith("@@"))) return prefixed([[dim(truncate(summary, room))]]);
    return prefixed([[dim("no changes")]]);
  }
  const total = Math.max(changed.length, (diff.added ?? 0) + (diff.removed ?? 0));
  const shown = changed.slice(0, max);
  const rows: Span[][] = shown.map((l) => [
    { text: truncate(l, room), fg: l.startsWith("+") ? palette.green : palette.red },
  ]);
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
  return sanitize(msg)
    .split("\n")
    .flatMap((l, i) => wrapSpans([red(i === 0 ? `${G.cross} ${l}` : `  ${l}`)], width, { indent: "  " }));
}

export function fmtNote(text: string, width = Infinity): Line[] {
  return sanitize(text)
    .split("\n")
    .flatMap((l) => (Number.isFinite(width) ? wrapSpans([dim(l)], width) : [[dim(l)]]));
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
