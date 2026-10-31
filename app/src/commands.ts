/**
 * The slash commands of the prompt. Each one is a thin call on the controller
 * (which owns the session, the bridge and the state they change) plus the
 * lines it prints. `COMMANDS` is the table; the footer suggests from
 * `SLASH_COMMANDS` and the controller runs `commandTable()`.
 */
import type { SlashCommand } from "./footer/SlashSuggest";
import type { Line, Span } from "./scrollback";
import type { CommandFn, Controller, PanelId } from "./session/controller";
import { themeCommand, toolsCommand, websearchCommand } from "./session/hubSettings";
import { fmtMemoryChange, type MemoryChange } from "./session/learn";
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

/** Opens an AIhub window; an argument (the window takes none) is ignored. */
const panel = (id: PanelId): CommandFn => (c) => void c.openPanel(id);

/** Opens an AIhub window without an argument; AIhub's text form with one. */
const panelOr = (id: PanelId, form: (c: Controller, arg: string) => void): CommandFn => (c, arg) =>
  arg.trim() ? form(c, arg.trim()) : void c.openPanel(id);

/** `/temp 0.3`: AIhub's text form (a comma is a decimal point). */
function temp(c: Controller, arg: string): Promise<void> | void {
  const t = Number(arg.replace(",", "."));
  if (!Number.isFinite(t) || t < 0 || t > 2) return c.error("Temperature is a number from 0 to 2, e.g. /temp 0.3");
  return c.setTemperature(t);
}

export const COMMANDS: Command[] = [
  { name: "help", args: "[keys]", help: "Show the commands and keys", run: panelOr("help", (c) => help(c)) },
  { name: "mode", args: "[plan|build|auto]", help: "Show or change the mode", run: (c, arg) => c.mode(arg) },
  { name: "plan", help: "Switch to plan mode (no edits)", run: (c) => c.mode("plan", "plan") },
  { name: "model", args: "[name]", help: "Models window; /model <name> switches (a new session)", run: panelOr("models", (c, a) => c.switchModel(a)) },
  { name: "undo", args: "[force]", help: "Undo the last turn's file changes", run: (c, arg) => undo(c, arg) },
  { name: "compact", help: "Summarize the conversation to free context", run: (c) => c.compact() },
  { name: "todos", help: "Show the model's todo list", run: (c) => c.showTodos() },
  { name: "rules", args: "[remove N]", help: "List permission rules, or remove one", run: (c, arg) => rules(c, arg) },
  { name: "sessions", help: "Pick an earlier session of this folder", run: (c) => c.openSessions() },
  { name: "resume", args: "[id]", help: "Resume an earlier session", run: (c, arg) => (arg.trim() ? c.resumeSession(arg.trim()) : c.openSessions("resume")) },
  { name: "clear", help: "Start over on the same model: a new code session, or a new chat under chat and agents", run: (c) => c.clear() },
  { name: "new", help: "Same as /clear", run: (c) => c.clear() },
  { name: "context", help: "Show how much context is used", run: (c) => context(c) },
  { name: "models", help: "Models: installed, catalog, downloads, context", run: panel("models") },
  { name: "hardware", help: "What this machine and the Ollama server have", run: panel("hardware") },
  { name: "agent", args: "[code|chat|<name>]", help: "Talk to the code agent, plain chat or an AIhub agent", run: (c, arg) => agent(c, arg) },
  { name: "agents", help: "AIhub's agent profiles", run: panel("agents") },
  { name: "skills", help: "Browse, create and install skills", run: panel("skills") },
  { name: "skill", args: "<name> [task]", help: "Use a skill → /skill <name> <task>", run: panelOr("skills", (c, a) => skill(c, a)) },
  { name: "mcp", help: "Connections: Google, GitHub and other services", run: panel("mcp") },
  { name: "kb", args: "[name…|off]", help: "Answer from a knowledge base in this chat, or list them", run: (c, arg) => c.applyKb(arg.trim()) },
  { name: "knowledge", help: "Knowledge bases: search your own documents", run: panel("knowledge") },
  { name: "schedule", args: "[run <name>]", help: "Scheduled tasks: agents on a timetable", run: panelOr("schedule", (c, a) => schedule(c, a)) },
  { name: "history", help: "AIhub's saved conversations", run: panel("history") },
  { name: "memory", args: "[save|clear|undo]", help: "Edit what AIhub remembers about you", run: panelOr("memory", (c, a) => memory(c, a)) },
  { name: "memoryadd", help: "Auto-extract facts from this chat → memory", run: (c) => memoryAdd(c) },
  { name: "settings", help: "Ollama server, default model, memory, tools", run: panel("settings") },
  { name: "theme", args: "[name]", help: "Colours: terminal (default), aihub, nord… → /theme nord", run: panelOr("theme", themeCommand) },
  { name: "tools", help: "List the agent tools the engine has", run: (c) => toolsCommand(c) },
  { name: "websearch", args: "[query]", help: "Try web search once", run: (c, arg) => websearchCommand(c, arg) },
  { name: "temp", args: "[value]", help: "Temperature → /temp 0.3 (or pick)", run: panelOr("temperature", (c, a) => temp(c, a)) },
  { name: "exit", help: "Leave aihub-code", run: (c) => c.exit() },
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
  lines.push(...wrapSpans([dim("  enter send · ctrl+j new line · shift+tab mode · up/down earlier prompts · ctrl+p palette")], width, { indent: "  " }));
  lines.push(...wrapSpans([dim("  esc interrupt · ctrl+c interrupt, clear, exit · ctrl+d exit")], width, { indent: "  " }));
  lines.push(...fmtNote("Shift+Enter needs a terminal with the kitty keyboard protocol; Ctrl+J always adds a line.", width));
  lines.push(...fmtNote("To send text that begins with /, start it with //.", width));
  c.write([[], ...lines]);
}

// ── /agent ────────────────────────────────────────────────────────────────────

/** `/agent` picks in the agents window (it has no separate manage mode, so
 *  /agents opens the same); `/agent code|chat|<profile> [plan|build]` switches. */
function agent(c: Controller, arg: string): Promise<void> | void {
  const [name = "", sub = "", ...rest] = arg.trim().split(/\s+/).filter(Boolean);
  if (!name) return void c.openPanel("agents");
  const submode = sub.toLowerCase();
  if (rest.length || (submode && submode !== "plan" && submode !== "build")) return c.note("usage: /agent, /agent code, /agent chat or /agent <profile> [plan]");
  const lower = name.toLowerCase();
  if (lower === "code" || lower === "chat") {
    if (submode) return c.note(`/agent ${lower} takes no mode`);
    return c.setKind({ type: lower });
  }
  // AIhub's profile names are lower case (agents.validate).
  return c.setKind({ type: "agent", name: lower, submode: submode === "plan" ? "plan" : "build" });
}

// ── /skill, /memory ───────────────────────────────────────────────────────────

/** `/skill <name> [task]` (AIhub slash.ts): the first word names the skill. */
function skill(c: Controller, arg: string): Promise<void> {
  const sp = arg.search(/\s/);
  return c.useSkill(sp > 0 ? arg.slice(0, sp) : arg, sp > 0 ? arg.slice(sp + 1).trim() : "");
}

const failed = (c: Controller, what: string) => (e: unknown) => c.error(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);

/** `/memory save <key> <value> | clear | undo`, with AIhub's texts (ChatScreen handleSlash). */
async function memory(c: Controller, arg: string): Promise<void> {
  const word = arg.toLowerCase();
  if (word === "clear") {
    await c.request("memory.clear").then(() => c.note("Memory cleared."), failed(c, "Clearing memory"));
  } else if (word === "undo") {
    await c.request<{ reverted?: MemoryChange[] }>("memory.undo", {}).then((d) => {
      const undone = Array.isArray(d?.reverted) ? d.reverted : [];
      if (!undone.length) return c.note("Nothing to undo — memory hasn't learned anything since the last undo.");
      for (const u of undone) c.write(fmtMemoryChange({ ...u, op: "undo" }, c.columns()));
    }, failed(c, "Undoing memory"));
  } else if (word.startsWith("save ")) {
    const body = arg.slice("save ".length).trim();
    const sp = body.search(/\s/);
    if (sp <= 0) return c.error("Usage: /memory save <key> <value>");
    const key = body.slice(0, sp);
    const value = body.slice(sp + 1).trim();
    await c.request("memory.save_entry", { key, value }).then(() => c.note(`Saved “${key}” to memory.`), failed(c, "Saving to memory"));
  } else if (word === "save") {
    c.error("Usage: /memory save <key> <value>");
  } else {
    c.error("Unknown /memory subcommand.");
  }
}

/** `/memoryadd`: learn from the whole conversation now (memory.extract). It
 *  asks the memory model, so not while anything else has the model (a turn,
 *  a task, a learn, another extract). */
async function memoryAdd(c: Controller): Promise<void> {
  if (!c.requireSession() || !c.modelFree()) return;
  const { model } = c.getState();
  if (!model) return c.error("No model selected.");
  const messages = c.conversationMessages();
  if (!messages.some((m) => (m as { role?: unknown } | null)?.role === "user")) return c.note("Nothing to learn from yet.");
  c.note("Extracting facts from this chat…");
  await c.extractMemory<{ ok?: boolean; summary?: string }>({ model, messages }, {
    ok: (d) => {
      if (d?.ok) c.note("Memory updated with extracted facts.");
      else c.error(String(d?.summary ?? "Extracting memory failed."));
    },
    fail: failed(c, "Extracting memory"),
  });
}

// ── /schedule ─────────────────────────────────────────────────────────────────

/** `/schedule run <name>` (AIhub's schedule_run): the task must exist; it
 *  runs after whatever has the model. */
async function schedule(c: Controller, arg: string): Promise<void> {
  const m = /^run(?:\s+([\s\S]*))?$/i.exec(arg);
  if (!m) return c.note("usage: /schedule, or /schedule run <name>");
  const name = oneLine(m[1] ?? "").trim();
  if (!name) return void c.openPanel("schedule");
  await c.request<{ tasks?: { name: string }[] }>("schedule.list", {}).then((d) => {
    if (!(d?.tasks || []).some((t) => t.name === name)) return c.error(`No task named ${name} \u2014 /schedule to see tasks.`);
    if (c.runTask(name)) c.note(`Running task ${name}\u2026`);
  }, failed(c, "Listing tasks"));
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
  if (!c.requireSession() || !c.requireCode("rules")) return;
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
