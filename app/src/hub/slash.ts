// Ported from AIhub-TUI v1.5.0 app/src/slash.ts.
export interface SlashCommand {
  cmd: string;
  desc: string;
}

/** Mirrors tui/widgets/slash_suggest.py COMMANDS.
 *  aihub-code: without /terminal and /cd (not in the line CLI) and without the
 *  F-key / ^G hints (aihub-code has no such keys; the windows open from these
 *  commands or the palette). */
export const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/new", desc: "Start a fresh chat (same model)" },
  { cmd: "/help", desc: "Show help & key bindings" },
  { cmd: "/model", desc: "Switch model" },
  { cmd: "/memory", desc: "Show saved memory" },
  { cmd: "/memory save", desc: "Save a fact → /memory save <key> <value>" },
  { cmd: "/memory clear", desc: "Delete all memory" },
  { cmd: "/memory undo", desc: "Undo what memory learned last" },
  { cmd: "/memoryadd", desc: "Auto-extract facts from this chat → memory" },
  { cmd: "/history", desc: "Browse & resume past sessions" },
  { cmd: "/agent", desc: "Pick or create an agent" },
  { cmd: "/skills", desc: "Browse, create & install skills" },
  { cmd: "/skill", desc: "Use a skill → /skill <name> <task>" },
  { cmd: "/mcp", desc: "Connections: Google, GitHub and other services" },
  { cmd: "/knowledge", desc: "Knowledge bases: search your own documents" },
  { cmd: "/kb", desc: "Use a knowledge base in this chat → /kb <name>, /kb off" },
  { cmd: "/schedule", desc: "Scheduled tasks: agents on a timetable" },
  { cmd: "/schedule run", desc: "Run a scheduled task now → /schedule run <name>" },
  { cmd: "/tools", desc: "List available agentic tools" },
  { cmd: "/clear", desc: "Clear chat context (keep system)" },
  { cmd: "/websearch", desc: "Test web search → /websearch <query>" },
  { cmd: "/temp", desc: "Temperature → /temp 0.3 (or pick)" },
];

/** Suggestions for the current input, or [] when the popup should be hidden. */
export function filterSlash(text: string, extra: SlashCommand[] = []): SlashCommand[] {
  if (!text.startsWith("/") || text.endsWith(" ")) return [];
  const q = text.toLowerCase();
  const matches = [...SLASH_COMMANDS, ...extra].filter(
    (c) => c.cmd.startsWith(q) || c.cmd.toLowerCase().includes(q.slice(1)),
  );
  return matches.length ? matches : [];
}

export interface SlashResult {
  kind:
    | "new"
    | "clear"
    | "help"
    | "tools"
    | "model"
    | "agent"
    | "skills"
    | "mcp"
    | "knowledge"
    | "terminal"
    | "kb"
    | "schedule"
    | "schedule_run"
    | "skill"
    | "history"
    | "memory_show"
    | "memory_save"
    | "memory_clear"
    | "memory_undo"
    | "memory_extract"
    | "cd"
    | "websearch"
    | "temp"
    | "unknown";
  payload?: { key?: string; value?: string; path?: string };
  message?: string;
}

/** Parse a submitted slash line — port of slash.py parse_slash. */
export function parseSlash(raw: string): SlashResult {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (lower === "/new") return { kind: "new" };
  if (lower === "/cd" || lower.startsWith("/cd ")) return { kind: "cd", payload: { path: text.slice(3).trim() } };
  if (lower === "/clear") return { kind: "clear" };
  if (lower === "/temp" || lower.startsWith("/temp "))
    return { kind: "temp", payload: { value: text.slice("/temp".length).trim() } };
  if (lower === "/websearch" || lower.startsWith("/websearch "))
    return { kind: "websearch", payload: { value: text.slice("/websearch".length).trim() } };
  if (lower === "/help") return { kind: "help" };
  if (lower === "/tools") return { kind: "tools" };
  if (lower === "/model") return { kind: "model" };
  if (lower === "/agent" || lower === "/agents") return { kind: "agent" };
  if (lower === "/skills" || lower === "/skill") return { kind: "skills" };
  if (lower === "/mcp" || lower === "/connections") return { kind: "mcp" };
  if (lower === "/knowledge") return { kind: "knowledge" };
  if (lower === "/terminal") return { kind: "terminal" };
  if (lower === "/schedule") return { kind: "schedule" };
  if (lower === "/schedule run" || lower.startsWith("/schedule run "))
    return { kind: "schedule_run", payload: { value: text.slice("/schedule run".length).trim() } };
  if (lower === "/kb" || lower.startsWith("/kb ")) return { kind: "kb", payload: { value: text.slice(3).trim() } };
  if (lower.startsWith("/skill ")) {
    const rest = text.slice("/skill ".length).trim();
    const sp = rest.indexOf(" ");
    return {
      kind: "skill",
      payload: { key: sp > 0 ? rest.slice(0, sp) : rest, value: sp > 0 ? rest.slice(sp + 1).trim() : "" },
    };
  }
  if (lower === "/history") return { kind: "history" };
  if (lower === "/memoryadd") return { kind: "memory_extract" };
  if (lower === "/memory") return { kind: "memory_show" };
  if (lower.startsWith("/memory ")) {
    const rest = text.slice("/memory ".length).trim();
    if (rest.toLowerCase() === "clear") return { kind: "memory_clear" };
    if (rest.toLowerCase() === "undo") return { kind: "memory_undo" };
    if (rest.toLowerCase().startsWith("save ")) {
      const body = rest.slice("save ".length).trim();
      const sp = body.indexOf(" ");
      if (sp > 0) {
        return { kind: "memory_save", payload: { key: body.slice(0, sp), value: body.slice(sp + 1) } };
      }
      return { kind: "unknown", message: "Usage: /memory save <key> <value>" };
    }
    return { kind: "unknown", message: "Unknown /memory subcommand." };
  }
  return { kind: "unknown", message: `Unknown command: ${text}` };
}
