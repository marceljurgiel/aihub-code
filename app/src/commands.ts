/**
 * The slash commands of the prompt. Each one is a thin call on the controller
 * (which owns the session, the bridge and the state they change) plus the
 * lines it prints. `COMMANDS` is the table; the footer suggests from
 * `SLASH_COMMANDS` and the controller runs `commandTable()`.
 */
import type { SlashCommand } from "./footer/SlashSuggest";
import type { Line, Span } from "./scrollback";
import type { CommandFn, Controller } from "./session/controller";
import { fmtNote } from "./transcript/format";
import { displayWidth, sanitize, stripCR, wrapSpans } from "./width";

export interface Command {
  /** Without the slash. */
  name: string;
  /** Shown after the name in /help: `[plan|build|auto]`. */
  args?: string;
  help: string;
  run: CommandFn;
}

const dim = (text: string): Span => ({ text, dim: true });
const oneLine = (t: unknown): string => sanitize(stripCR(String(t ?? ""))).replace(/\n/g, " ");
const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const COMMANDS: Command[] = [
  { name: "help", help: "Show the commands and keys", run: (c) => help(c) },
  { name: "mode", args: "[plan|build|auto]", help: "Show or change the mode", run: (c, arg) => c.mode(arg) },
  { name: "plan", help: "Switch to plan mode (no edits)", run: (c) => c.mode("plan") },
  { name: "model", args: "[name]", help: "Choose a model (starts a new session)", run: (c, arg) => c.switchModel(arg.trim()) },
  { name: "undo", args: "[force]", help: "Undo the last turn's file changes", run: (c, arg) => undo(c, arg) },
  { name: "compact", help: "Summarize the conversation to free context", run: (c) => c.compact() },
  { name: "todos", help: "Show the model's todo list", run: (c) => c.showTodos() },
  { name: "rules", args: "[remove N]", help: "List permission rules, or remove one", run: (c, arg) => rules(c, arg) },
  { name: "sessions", help: "Pick an earlier session of this folder", run: (c) => c.openSessions() },
  { name: "resume", args: "[id]", help: "Resume an earlier session", run: (c, arg) => (arg.trim() ? c.resumeSession(arg.trim()) : c.openSessions()) },
  { name: "clear", help: "New session on the same model and mode", run: (c) => c.clear() },
  { name: "context", help: "Show how much context is used", run: (c) => context(c) },
  { name: "memory", help: "Edit what AIhub remembers about you", run: (c) => void c.openPanel("memory") },
  { name: "exit", help: "Leave aihub-code", run: (c) => c.exit() },
  { name: "hub", help: "Where models, agents and connections live", run: (c) => hub(c) },
];

/** For the footer's suggestions under the box. */
export const SLASH_COMMANDS: SlashCommand[] = COMMANDS.map((c) => ({ name: c.name, hint: c.help }));

/** The controller's lookup: name without the slash. */
export const commandTable = (): Record<string, CommandFn> => Object.fromEntries(COMMANDS.map((c) => [c.name, c.run]));

// ── /help ─────────────────────────────────────────────────────────────────────

function help(c: Controller): void {
  const width = c.columns();
  const label = (cmd: Command) => `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
  const col = Math.max(...COMMANDS.map((x) => displayWidth(label(x))));
  const stacked = width < col + 4 + 20;
  const lines: Line[] = [[{ text: "Commands", bold: true }]];
  for (const cmd of COMMANDS) {
    if (stacked) {
      lines.push([{ text: `  ${label(cmd)}` }]);
      lines.push(...wrapSpans([dim(`    ${cmd.help}`)], width, { indent: "    " }));
    } else {
      const head = `  ${label(cmd).padEnd(col)}  `;
      lines.push(...wrapSpans([{ text: head }, dim(cmd.help)], width, { indent: " ".repeat(head.length) }));
    }
  }
  lines.push([], [{ text: "Keys", bold: true }]);
  lines.push(...wrapSpans([dim("  enter send · ctrl+j new line · shift+tab mode · up/down earlier prompts")], width, { indent: "  " }));
  lines.push(...wrapSpans([dim("  esc interrupt · ctrl+c interrupt, clear, exit · ctrl+d exit")], width, { indent: "  " }));
  lines.push(...fmtNote("Shift+Enter needs a terminal with the kitty keyboard protocol; Ctrl+J always adds a line.", width));
  lines.push(...fmtNote("To send text that begins with /, start it with //.", width));
  c.write([[], ...lines]);
}

// ── /undo ─────────────────────────────────────────────────────────────────────

async function undo(c: Controller, arg: string): Promise<void> {
  const a = arg.trim().toLowerCase();
  if (a !== "" && a !== "force") return c.note("usage: /undo, or /undo force");
  await c.undo(a === "force");
}

// ── /context ──────────────────────────────────────────────────────────────────

function context(c: Controller): void {
  if (!c.requireSession()) return;
  const { used, limit } = c.getState().ctx;
  if (limit <= 0) return c.note("context: size not known yet");
  c.note(`context: ${Math.min(100, Math.round((100 * used) / limit))}% used (${tokens(used)} of ${tokens(limit)} tokens)`);
}

// ── /rules ────────────────────────────────────────────────────────────────────

interface Rule {
  tool: string;
  pattern: string | null;
  scope: string;
}

const ruleText = (r: Rule): string => (r.pattern ? `${oneLine(r.tool)}: ${oneLine(r.pattern)}` : oneLine(r.tool));

async function rules(c: Controller, arg: string): Promise<void> {
  if (!c.requireSession()) return;
  const word = arg.trim();
  const remove = /^remove(?:\s+(\S+))?$/i.exec(word);
  if (word !== "" && !remove) return c.note("usage: /rules, or /rules remove N");
  const { rules: list = [] } = await c.request<{ rules?: Rule[] }>("code.rules.list", {});
  if (!remove) {
    if (list.length === 0) return c.note("no rules yet — \"don't ask again\" in a permission prompt adds one");
    const width = c.columns();
    c.write([
      [{ text: "rules:", bold: true }],
      ...list.flatMap((r, i) => wrapSpans([{ text: `  ${i + 1}. ${ruleText(r)} (${oneLine(r.scope)})` }], width, { indent: "     " })),
      ...fmtNote("/rules remove N removes one", width),
    ]);
    return;
  }
  const n = remove[1];
  if (!n || !/^\d+$/.test(n)) return c.note("usage: /rules remove N");
  const rule = list[Number(n) - 1];
  if (!rule) return c.note(`no rule ${n} — /rules lists them`);
  await c.request("code.rules.remove", { tool: rule.tool, pattern: rule.pattern, scope: rule.scope });
  c.note(`removed rule ${n}: ${ruleText(rule)}`);
}

// ── /hub ──────────────────────────────────────────────────────────────────────

function hub(c: Controller): void {
  c.note("The models catalogue, agents, connections and knowledge bases live in aihub, which shares these settings.");
}
