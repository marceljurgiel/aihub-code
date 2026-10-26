// Ported from AIhub-TUI v1.5.0 app/src/keymap/actions.ts.
/**
 * Every user-facing action, its label, and how it is reached.
 *
 * This table is the single source of truth for four things that drifted apart
 * in the Textual app: the keymap layers, the sidebar nav list, the `/help`
 * output, and (Phase 4) the command palette. Adding an action here is enough
 * to make it bindable, navigable, and documented.
 */
export type ActionId =
  | "new_chat"
  | "agent"
  | "schedule"
  | "skills"
  | "mcp"
  | "model_picker"
  | "history"
  | "memory"
  | "knowledge"
  | "hardware"
  | "settings"
  | "command_palette"
  | "help"
  | "clear_chat"
  | "save_session"
  | "toggle_tools"
  | "temperature"
  | "theme"
  | "terminal"
  | "terminal_close"
  | "cancel_stream"
  | "quit";

export interface ActionSpec {
  id: ActionId;
  label: string;
  /** Chord that fires even while the chat input has focus (keymap "global"). */
  key?: string;
  /** Extra chords bound to the same action but not advertised in help. */
  altKeys?: string[];
  /** Bare letter, live only when no text field is focused (keymap "nav"). */
  nav?: string;
  /** Appears in the sidebar nav, in declaration order. */
  sidebar?: boolean;
  /** Sidebar section and glyph (single-width characters only). */
  group?: "chat" | "models" | "system";
  icon?: string;
}

export const SIDEBAR_GROUPS: ReadonlyArray<{ id: NonNullable<ActionSpec["group"]>; label: string }> = [
  { id: "chat", label: "chat" },
  { id: "models", label: "models" },
  { id: "system", label: "system" },
];

// aihub-code: the actions this line CLI has — what the palette offers and what
// the Help window lists. There is no sidebar and no F-key layer: a window opens
// from its slash command or from here, so only the palette keeps its chord.
// Left out on purpose: the terminal panel (aihub-code runs in a terminal),
// clear chat (/clear is the new session, as New Chat), save session (code
// sessions save themselves), toggle tools and cancel stream (Esc in the prompt;
// the palette can't open during a turn).
export const ACTIONS: readonly ActionSpec[] = [
  { id: "new_chat", label: "New Chat" },
  { id: "agent", label: "Agent" },
  { id: "schedule", label: "Schedule" },
  { id: "skills", label: "Skills" },
  { id: "model_picker", label: "Models" },
  { id: "history", label: "History" },
  { id: "memory", label: "Memory" },
  { id: "knowledge", label: "Knowledge" },
  { id: "mcp", label: "Connections" },
  { id: "hardware", label: "Hardware" },
  { id: "settings", label: "Settings" },
  { id: "theme", label: "Theme" },
  { id: "temperature", label: "Temperature" },
  { id: "command_palette", label: "Palette", key: "ctrl+p" },
  { id: "help", label: "Help" },
  { id: "quit", label: "Quit" },
];

export const SIDEBAR_ACTIONS = ACTIONS.filter((a) => a.sidebar);

/** "ctrl+o" → "^O", "f1" → "F1", "escape" → "Esc" — status-bar shorthand. */
export function shortKey(key: string): string {
  if (key === "escape") return "Esc";
  if (/^f\d+$/.test(key)) return key.toUpperCase();
  const m = /^ctrl\+(.+)$/.exec(key);
  if (m) return "^" + (m[1]!.length === 1 ? m[1]!.toUpperCase() : m[1]!);
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The `/help` body, generated so it can never contradict the live bindings. */
export function helpText(slashLines: string): string {
  const chords = ACTIONS.filter((a) => a.key)
    .map((a) => `${shortKey(a.key!)} ${a.label}`)
    .join(" · ");
  const nav = ACTIONS.filter((a) => a.nav)
    .map((a) => `${a.nav} ${a.label.toLowerCase()}`)
    .join(" · ");
  return `Keys: ${chords}\nQuick nav (input unfocused): ${nav}\n${slashLines}`;
}
