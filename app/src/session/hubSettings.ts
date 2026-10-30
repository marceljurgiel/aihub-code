/**
 * What AIhub's Settings and Theme windows, `/theme`, `/tools` and `/websearch`
 * do in aihub-code, apart from the windows themselves. They act through the
 * controller's public methods (request, note, error, getState).
 */
import { THEMES, ACCENTS, activeTheme, applyTheme } from "../hub/theme";
import { saveCodeTheme } from "../theme";
import { sanitize } from "../width";
import type { Controller } from "./controller";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const oneLine = (t: unknown): string => sanitize(String(t ?? "")).replace(/\s+/g, " ").trim();

// ── theme ─────────────────────────────────────────────────────────────────────

/** A theme by id (`tokyo-night`) or label (`Tokyo Night`), any case. */
export function themeId(arg: string): string | null {
  const q = arg.trim().toLowerCase();
  if (!q) return null;
  return Object.keys(THEMES).find((id) => id === q || THEMES[id]!.label.toLowerCase() === q) ?? null;
}

/**
 * Keep a theme: aihub-code's own settings file holds the theme (AIhub's
 * `theme:` in config.yaml is ignored: ruling R-T2-2). The accent is AIhub's
 * shared setting, so it goes to config.yaml when `accent` is given (the Theme
 * window); `/theme <name>` leaves it alone.
 */
export async function saveTheme(c: Controller, name: string, accent: string | null = null): Promise<void> {
  applyTheme(name, accent ?? activeTheme.accent);
  try {
    saveCodeTheme(activeTheme.name);
  } catch (e) {
    return c.error(`Saving the theme failed: ${errText(e)}`);
  }
  if (accent !== null) {
    try {
      await c.request("config.set", { patch: { accent } });
    } catch (e) {
      c.error(`Saving the accent failed: ${errText(e)}`);
    }
  }
  const id = activeTheme.name;
  const acc = activeTheme.accent;
  c.note(`Theme → ${THEMES[id]?.label ?? id}${acc ? `, ${ACCENTS[acc]?.label} accent` : ""}.`);
}

/** `/theme <name>` (the window without a name). */
export function themeCommand(c: Controller, arg: string): Promise<void> | void {
  const id = themeId(arg);
  if (!id) return c.error(`No theme named ${oneLine(arg)} — try: ${Object.keys(THEMES).join(", ")}.`);
  return saveTheme(c, id);
}

// ── settings ──────────────────────────────────────────────────────────────────

/** Settings saved a different Ollama server: its models are the ones to pick
 *  from now (ChatScreen onEngineChanged). */
export async function ollamaChanged(c: Controller): Promise<void> {
  try {
    const d = await c.request<{ models?: { name: string }[] }>("models.installed");
    const names = (d?.models ?? []).map((m) => m.name);
    const { backend, model } = c.getState();
    if (backend === "ollama" && model && !names.includes(model))
      c.error(`${model} isn't on this Ollama server — /models lists its ${names.length} model${names.length === 1 ? "" : "s"}.`);
  } catch (e) {
    c.error(`Listing models on the new Ollama server failed: ${errText(e)}`);
  }
}

// ── /tools, /websearch ────────────────────────────────────────────────────────

/** `/tools`: what the engine's agentic tools are. */
export async function toolsCommand(c: Controller): Promise<void> {
  try {
    const d = await c.request<{ text?: string }>("tools.describe");
    c.note(d?.text || "(no tools)");
  } catch (e) {
    c.error(`Listing tools failed: ${errText(e)}`);
  }
}

/** `/websearch [query]`: tries the engine's web search once (search.check), as AIhub does. */
export async function websearchCommand(c: Controller, arg: string): Promise<void> {
  const query = arg.trim();
  c.note(`Searching the web for “${oneLine(query) || "weather Lisbon"}”…`);
  try {
    const d = await c.request<{ ok?: boolean; count?: number; source?: string; first?: { title?: string; url?: string }; failures?: string[] }>("search.check", { query });
    if (d?.ok) c.note(`Web search works — ${d.count} results via ${oneLine(d.source)}. First: ${oneLine(d.first?.title)} — ${oneLine(d.first?.url)}`);
    else c.error(`Web search failed: ${(d?.failures ?? []).map(oneLine).join("; ") || "no results"}`);
  } catch (e) {
    c.error(`Testing web search failed: ${errText(e)}`);
  }
}
