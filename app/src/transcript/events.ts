/**
 * The bridge events the transcript shows, as the Python engine emits them
 * (aihub_code/engine/turn.py `event_payload`, session.py, tools.py). Only the
 * fields the formatters read are typed.
 */
export interface ToolCallEvent {
  call_id?: string;
  name: string;
  arguments: Record<string, unknown>;
  round?: number;
}

export interface ToolResultEvent {
  call_id?: string;
  name: string;
  arguments?: Record<string, unknown>;
  /** The tool's text output; failures are reported in-band ("[File Error] …"). */
  result: string;
  duration_ms?: number;
  round?: number;
  /** Set when the call failed, was denied, or a command exited non-zero. */
  error?: string | null;
  denied?: boolean;
}

/** `code_diff`: what edit_file / write_file changed (aihub_code/diffs.py). */
export interface DiffEvent {
  path: string;
  /** A unified diff, headers included. */
  text: string;
  added: number;
  removed: number;
  created: boolean;
  truncated?: boolean;
  error?: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** `code_compaction`: token counts before and after (aihub_code/compaction.py). */
export interface CompactionEvent {
  method: string;
  before: number;
  after: number;
  kept_turns?: number;
}

/** What the header line shows (from `code.start`'s answer and the app's own state). */
export interface HeaderInfo {
  version: string;
  model: string;
  mode: string;
  root: string;
  branch?: string | null;
  /** Shown as `~`; defaults to the user's home. Injectable for tests. */
  home?: string;
}
