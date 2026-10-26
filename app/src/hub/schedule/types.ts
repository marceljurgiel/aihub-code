// Ported from AIhub-TUI v1.5.0 app/src/schedule/types.ts.
/** A scheduled task as `schedule.list` returns it: the task file plus its run
 *  state. Tasks run only while AIhub is open (the app keeps the clock). */
export interface ScheduledTask {
  name: string;
  agent: string;
  model: string;
  backend: string;
  stream_model: string;
  when: string;
  prompt: string;
  enabled: boolean;
  created: string;
  path: string;
  /** Why the task file couldn't be read ("" = fine). */
  broken: string;
  next_run: string | null;
  last_run?: string | null;
  last_status?: "ok" | "error" | "cancelled" | "skipped" | null;
  last_summary?: string;
  last_session?: { model: string; filename: string } | null;
  last_error?: string;
}

/** A slot that passed while AIhub was closed (`schedule.check {startup}`). */
export interface MissedTask {
  name: string;
  when: string;
  slot: string;
}

/** What a new task gets as its model: the active session's. */
export interface CurrentModel {
  model: string;
  backend: string;
  streamModel: string;
}
