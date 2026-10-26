/**
 * Things the app does around the transcript that are not the controller's job:
 * turning a resumed session's saved messages back into lines, the resize
 * debounce, how tall the footer may get, and the line printed on exit.
 */
import { G } from "./glyphs";
import type { Line } from "./scrollback";
import type { TodoItem, ToolCallEvent, ToolResultEvent } from "./transcript/events";
import { fmtNote, fmtTodos, fmtToolCall, fmtToolResult, fmtUser } from "./transcript/format";
import { MarkdownStreamer } from "./transcript/markdown";

// What the engine writes into a session besides real conversation
// (aihub_code/compaction.py SUMMARY_PREFIX, session.py UNDONE_NOTE).
const SUMMARY_PREFIX = "[Conversation summary]";
const UNDONE_NOTE = "[The user undid the file changes of that turn.]";
/** Result texts of calls that never ran (aihub_code/session.py, permissions.py). */
const DENIED = /^\s*(?:\[Denied|Plan mode:|Refused:)/;

const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

function callArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isObject(raw) ? raw : {};
}

/** The rows a saved tool result shows. Edits and writes had a diff live, which
 * is not saved: they say what happened instead. */
function resultLines(ev: ToolResultEvent, width: number): Line[] {
  const lines = fmtToolResult(ev, width);
  if (lines.length > 0) return lines;
  const said = ev.name === "edit_file" ? "edited" : ev.name === "write_file" ? "written" : "";
  return said ? [[{ text: `  ${G.elbow} ` }, { text: said, dim: true }]] : [];
}

/** A user message that is the engine's own note, not something the user typed. */
const isEngineNote = (content: string): boolean => content.startsWith(SUMMARY_PREFIX) || content === UNDONE_NOTE;

/** What the user typed in a saved conversation, oldest first (the prompt's Up history). */
export function userPrompts(messages: unknown[]): string[] {
  const out: string[] = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (isObject(m) && m.role === "user" && typeof m.content === "string" && m.content.trim() !== "" && !isEngineNote(m.content)) out.push(m.content);
  }
  return out;
}

/**
 * A resumed session's saved messages as transcript lines, laid out like a live
 * turn: `>` prompts, markdown replies, a tool line with its result under it.
 * The system prompt and the engine's own notes are not conversation: a
 * compaction summary and an undo become one dim line each.
 */
export function messagesToLines(messages: unknown[], width: number): Line[] {
  const out: Line[] = [];
  const list = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!isObject(m)) continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (m.role === "user") {
      if (content.startsWith(SUMMARY_PREFIX)) out.push(...fmtNote(`${G.diamond} earlier messages were summarised`, width));
      else if (content === UNDONE_NOTE) out.push(...fmtNote("the file changes of that turn were undone", width));
      else if (content !== "") out.push([], ...fmtUser(content, width));
    } else if (m.role === "assistant") {
      const md = new MarkdownStreamer(width);
      out.push(...md.feed(content), ...md.flush());
      // The results follow the assistant message, in call order.
      const results: Record<string, any>[] = [];
      for (let next = list[i + 1]; isObject(next) && next.role === "tool"; next = list[i + 1]) {
        results.push(next);
        i++;
      }
      const calls: unknown[] = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      calls.forEach((raw, n) => {
        const fn = isObject(raw) && isObject(raw.function) ? raw.function : null;
        if (!fn || typeof fn.name !== "string") return;
        const args = callArguments(fn.arguments);
        const id = typeof (raw as any).id === "string" ? (raw as any).id : null;
        const msg = (id && results.find((r) => r.tool_call_id === id)) || results[n];
        const call: ToolCallEvent = { name: fn.name, arguments: args };
        out.push(...fmtToolCall(call, width));
        if (fn.name === "todo_write" && Array.isArray(args.todos)) out.push(...fmtTodos(args.todos as TodoItem[], width));
        if (!msg) return; // a turn that was cut off before this result
        const result = typeof msg.content === "string" ? msg.content : "";
        out.push(...resultLines({ name: fn.name, arguments: args, result, denied: DENIED.test(result) }, width));
      });
    }
  }
  return out;
}

/** A function that runs `fn` once things have been quiet for `ms`. */
export function debounced(fn: () => void, ms: number): (() => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const call = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return call;
}

/** Rows the scrollback keeps even when the footer is at its tallest. */
export const MIN_SCROLLBACK_ROWS = 5;
/** The smallest footer that still works: activity, a one-row box, status. */
export const MIN_FOOTER_ROWS = 5;

/** The most rows the footer may take on a terminal `terminalRows` tall. */
export const footerBudget = (terminalRows: number): number => Math.max(MIN_FOOTER_ROWS, terminalRows - MIN_SCROLLBACK_ROWS);

/** What is printed after the terminal is restored; null when there is nothing to resume. */
export const exitLine = (sessionId: string): string | null =>
  sessionId ? `Resume this session: aihub-code --resume ${sessionId}` : null;

/** The renderer's footer height: as asked, but on a terminal under 6 rows
 *  always one row less than the terminal (never below 1). */
export const clampFooterHeight = (rows: number, terminalRows: number): number =>
  terminalRows < 6 ? Math.max(1, Math.min(rows, terminalRows - 1)) : rows;
