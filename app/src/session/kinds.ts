/**
 * Who the prompt talks to, and the pure helpers around it: the code agent
 * (aihub-code's own session), plain chat, or one of AIhub's agent profiles
 * (both run by AIhub's chat.turn, see hubChat.ts). No state and no bridge:
 * the controller uses these to label, compare and draw.
 */
import type { Mode } from "../args";
import type { Line } from "../scrollback";
import type { DiffEvent } from "../transcript/events";
import { fmtError, fmtNote } from "../transcript/format";
import { sanitize, stripCR } from "../width";
import type { AgentInfo, HubKind } from "./hubChat";

/** Who the prompt talks to: the code agent (aihub-code's own session), plain
 *  chat, or one of AIhub's agent profiles (both run by AIhub's chat.turn). */
export type Kind = { type: "code" } | HubKind;

export const CODE: Kind = { type: "code" };

export const sameKind = (a: Kind, b: Kind): boolean =>
  a.type === b.type && (a.type !== "agent" || (b.type === "agent" && a.name === b.name && a.submode === b.submode));

/** The status line's first word: the code agent's mode, `chat`, or
 *  `agent <name> · <submode>`. */
export function kindLabel(kind: Kind, mode: Mode): string {
  if (kind.type === "chat") return "chat";
  if (kind.type === "agent") return `agent ${kind.name} · ${kind.submode}`;
  return mode;
}

/** The divider written when a conversation of that kind begins. */
export const kindHeader = (kind: Kind, mode: Mode, model: string): string =>
  kind.type === "code" ? `code · ${mode} · ${model}` : `${kindLabel(kind, mode)} · ${model}`;

/** agent.check's answer (bridge _h_agent_check). */
export interface AgentCheck {
  ok?: boolean;
  reason?: string;
  context?: number;
  context_note?: string;
  agent?: AgentInfo;
}

/** The most rows of an AIhub edit kept for the prompt (it shows a dozen):
 *  a multi-MB file is never split whole into state. */
export const HUB_DIFF_ROWS = 200;

/** The first `max` lines of `text` and how many there are in all, without
 *  splitting the whole of it. A final newline ends the last line (it starts
 *  no new one); "" has no lines. */
function headLines(text: string, max: number): { rows: string[]; total: number } {
  const rows: string[] = [];
  if (text === "") return { rows, total: 0 };
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  let total = 0;
  let pos = 0;
  while (pos <= end) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1 || nl > end) nl = end;
    if (rows.length < max) rows.push(text.slice(pos, nl));
    total++;
    pos = nl + 1;
  }
  return { rows, total };
}

/** What an AIhub turn's edit would change, as a diff for the prompt: AIhub
 *  shows the whole change before it is approved, and its permission_request
 *  carries only the tool's arguments (write_file {path, content}, edit_file
 *  {path, old, new}). write_file's content is not a diff (the file on disk
 *  isn't read): its label says it is the new content. */
export function hubDiff(name: string, args: unknown): DiffEvent | null {
  if (name !== "write_file" && name !== "edit_file") return null;
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const path = sanitize(str(a.path)).replace(/\n/g, " ");
  const edit = name === "edit_file";
  // An edit's old text gets half the rows at most: its new text shows too.
  const old = edit ? headLines(str(a.old), HUB_DIFF_ROWS / 2) : { rows: [], total: 0 };
  const added = headLines(str(edit ? a.new : a.content), HUB_DIFF_ROWS - old.rows.length);
  const row = (sign: string) => (l: string) => sign + sanitize(stripCR(l));
  return {
    path,
    text: [`--- a/${path}`, `+++ b/${path}`, ...old.rows.map(row("-")), ...added.rows.map(row("+"))].join("\n"),
    added: added.total,
    removed: old.total,
    created: false,
    ...(edit ? {} : { label: added.total === 0 ? "new content: an empty file" : "new content (the whole file)" }),
  };
}

/** AIhub's `knowledge` event of a chat turn: which documents the answer can
 *  draw on, or why it can't (ChatScreen's knowledge note). */
export function fmtKnowledge(data: any, width: number): Line[] {
  const kb = (Array.isArray(data?.bases) ? data.bases : []).join(", ");
  const sources: string[] = Array.isArray(data?.sources) ? data.sources.map(String) : [];
  if (data?.error) return fmtError(`Knowledge (${kb}): ${data.error}`, width);
  if (data?.hits)
    return fmtNote(
      `¶ ${kb}: ${data.hits} excerpt${data.hits === 1 ? "" : "s"} from ${sources.slice(0, 3).join(", ")}` +
        (sources.length > 3 ? "…" : ""),
      width,
    );
  return fmtNote(`¶ ${kb}: nothing relevant found.`, width);
}
