/**
 * The session controller: the one place that turns bridge events into
 * transcript lines (through a ScrollbackSink) and into the small state the
 * footer draws. Plain TypeScript, no React: the bridge, the sink, the clock and
 * the terminal width are injected, so tests drive it with a mock bridge and a
 * memory sink. `useController` is the thin hook over getState()/subscribe().
 *
 * Rules the footer relies on:
 *  - one `code.turn` at a time; submit while a turn runs queues the prompt and
 *    the next one goes out after `done`;
 *  - a permission answer carries the prompt's `permission_id`; a second
 *    request replaces the first, and an answer meant for the old one is dropped;
 *  - after cancel every event of that turn is ignored but `done` (a prompt
 *    that still arrives is denied at once, so the engine never waits for it);
 *  - when the bridge dies the phase becomes "error" with the client's message
 *    printed red; the queue is kept and the input stays usable.
 */
import type { StreamHandle } from "../bridge/client";
import type { Args, Mode } from "../args";
import { G } from "../glyphs";
import type { Line, ScrollbackSink } from "../scrollback";
import type { CompactionEvent, DiffEvent, TodoItem, ToolCallEvent, ToolResultEvent } from "../transcript/events";
import {
  fmtCompaction,
  fmtDiff,
  fmtError,
  fmtHeader,
  fmtNote,
  fmtTodos,
  fmtToolCall,
  fmtToolResult,
  fmtUser,
} from "../transcript/format";
import { MarkdownStreamer } from "../transcript/markdown";
import { sanitize, stripCR } from "../width";

/** What the controller needs of BridgeClient (tests pass a mock). */
export interface Bridge {
  ready(): Promise<{ version: string }>;
  request<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  stream(method: string, params: Record<string, unknown>, onEvent: (event: string, data: any) => void): StreamHandle;
  permission(requestId: number, allow: boolean, extra?: Record<string, unknown>): void;
  send(control: { method: string; params?: Record<string, unknown> }): void;
  /** Why the bridge is gone, or null while it lives. */
  deadError(): Error | null;
}

export type Phase = "starting" | "idle" | "running" | "permission" | "picker" | "error";

export interface SuggestedRule {
  tool: string;
  pattern: string | null;
  scope: string;
}

/** The open permission prompt (a `permission_request` event). */
export interface PermissionState {
  /** The streaming request it belongs to (what chat.permission calls request_id). */
  requestId: number;
  /** Echoed in the answer; null only if an old engine sent none. */
  permissionId: number | null;
  name: string;
  arguments: Record<string, unknown>;
  diff: DiffEvent | null;
  suggestedRule: SuggestedRule | null;
  mode: string;
  reason: string;
}

export interface PickerItem {
  id: string;
  label: string;
}

export interface PickerState {
  kind: "model" | "session";
  title: string;
  items: PickerItem[];
}

export interface ControllerState {
  phase: Phase;
  mode: Mode;
  model: string;
  sessionId: string;
  ctx: { used: number; limit: number };
  activity: { label: string; since: number } | null;
  permission: PermissionState | null;
  queue: string[];
  todos: TodoItem[];
  /** The message behind phase "error". */
  error: string | null;
  picker: PickerState | null;
}

export type PermissionChoice = "yes" | "always" | { no: string | null };

export type CommandFn = (controller: Controller, arg: string) => void | Promise<void>;

export interface ControllerOptions {
  bridge: Bridge;
  sink: ScrollbackSink;
  /** Milliseconds; injectable so tests are deterministic. */
  now?: () => number;
  /** The terminal width at the time of writing. */
  width: () => number;
  /** The project folder (the bridge's cwd). */
  cwd?: string;
  /** What the header shows as `~`. */
  home?: string;
  /** Slash command table (name without the slash). */
  commands?: Record<string, CommandFn>;
  /** Called by exit(); the app destroys the renderer here. */
  onExit?: () => void;
  /** A resumed session's saved messages, for the app to replay into the scrollback. */
  onResume?: (messages: any[]) => void;
}

const MODES: Mode[] = ["build", "auto", "plan"];
const SHELL_TOOLS = new Set(["run_terminal", "run_shell"]);

interface Turn {
  handle: StreamHandle | null;
  cancelled: boolean;
  streamer: MarkdownStreamer;
}

export class Controller {
  private state: ControllerState = {
    phase: "starting",
    mode: "build",
    model: "",
    sessionId: "",
    ctx: { used: 0, limit: 0 },
    activity: null,
    permission: null,
    queue: [],
    todos: [],
    error: null,
    picker: null,
  };
  private listeners = new Set<() => void>();
  private turn: Turn | null = null;
  private version = "";
  private startArgs: Pick<Args, "mcp" | "kb"> & { mode: Mode } = { mode: "build", mcp: [], kb: [] };
  private shownNotes = new Set<string>();
  private turnsSent = 0;
  private resumed = false;
  private exited = false;
  // Mode changes: the engine takes one at a time, so quick presses coalesce.
  private modeConfirmed: Mode = "build";
  private modeWanted: Mode | null = null;
  private modeBusy = false;

  constructor(private readonly o: ControllerOptions) {}

  // ── state ──────────────────────────────────────────────────────────────────

  getState = (): ControllerState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private write(lines: Line[]): void {
    if (lines.length) this.o.sink.write(lines);
  }

  private error(text: string): void {
    this.write(fmtError(text, this.o.width()));
  }

  private note(text: string): void {
    this.write(fmtNote(text, this.o.width()));
  }

  // ── start-up ───────────────────────────────────────────────────────────────

  async start(args: Args): Promise<void> {
    this.startArgs = { mode: args.mode ?? "build", mcp: args.mcp, kb: args.kb };
    try {
      this.version = (await this.o.bridge.ready()).version;
    } catch (e) {
      return this.failStart(e);
    }
    let config: Record<string, unknown> = {};
    try {
      config = await this.o.bridge.request("config.get", {});
    } catch (e) {
      if (this.o.bridge.deadError()) return this.failStart(e);
      this.note(`could not read AIhub's settings: ${errText(e)}`);
    }
    const cwd = this.o.cwd ?? process.cwd();
    try {
      if (typeof args.resume === "string") return await this.resume(args.resume);
      if (args.cont || args.resume === true) {
        const { sessions = [] } = await this.o.bridge.request<{ sessions?: any[] }>("code.sessions", { cwd });
        if (sessions.length === 0) {
          this.note("no earlier session here: starting a new one");
        } else if (args.resume === true) {
          return this.openPicker({
            kind: "session",
            title: "Resume a session",
            items: sessions.map((s) => ({ id: String(s.id), label: sessionLabel(s) })),
          });
        } else {
          return await this.resume(String(sessions[0].id));
        }
      }
      const model = args.model || String(config.default_chat_model ?? "").trim();
      if (!model) return await this.pickModel();
      await this.startSession(model, true);
    } catch (e) {
      this.failStart(e);
    }
  }

  /** Picker answer: a model (before the first session) or a session to resume. */
  async pick(id: string | null): Promise<void> {
    const picker = this.state.picker;
    if (!picker) return;
    // "starting" while the session comes up: prompts typed meanwhile queue.
    this.set({ picker: null, phase: "starting" });
    try {
      if (picker.kind === "model") {
        if (id === null) return this.exit();
        await this.startSession(id, false); // it came from the server's own list
      } else if (id === null) {
        const model = (await this.o.bridge.request<Record<string, unknown>>("config.get", {})).default_chat_model;
        if (!model) return await this.pickModel();
        await this.startSession(String(model), true);
      } else {
        await this.resume(id);
      }
    } catch (e) {
      this.failStart(e);
    }
  }

  private async pickModel(missing?: string): Promise<void> {
    if (missing) this.note(`model ${missing} isn't available on the server \u2014 pick one`);
    const { models = [] } = await this.o.bridge.request<{ models?: { name: string }[] }>("models.installed", {});
    this.openPicker({
      kind: "model",
      title: "Choose a model",
      items: models.map((m) => ({ id: m.name, label: m.name })),
    });
  }

  private async modelMissing(model: string): Promise<boolean> {
    try {
      const [installed, cloud] = await Promise.all([
        this.o.bridge.request<{ models?: { name: string }[] }>("models.installed", {}),
        this.o.bridge.request<{ models?: { name: string }[] }>("cloud.models", {}),
      ]);
      if (!Array.isArray(installed.models) || !Array.isArray(cloud.models)) return false;
      return ![...installed.models, ...cloud.models].some((m) => m.name === model);
    } catch {
      return false;
    }
  }

  private openPicker(picker: PickerState): void {
    this.set({ phase: "picker", picker });
  }

  /** With `check`, a model the server has under neither list opens the picker
   *  instead. If a lookup fails (offline) we go ahead: the turn reports it. */
  private async startSession(model: string, check: boolean): Promise<void> {
    if (check && (await this.modelMissing(model))) return this.pickModel(model);
    const { mode, mcp, kb } = this.startArgs;
    const info = await this.o.bridge.request("code.start", {
      cwd: this.o.cwd ?? process.cwd(),
      model,
      mode,
      mcp,
      knowledge: kb,
    });
    this.begin(info, model);
  }

  private async resume(sessionId: string): Promise<void> {
    const info = await this.o.bridge.request("code.resume", { cwd: this.o.cwd ?? process.cwd(), session_id: sessionId });
    this.resumed = true;
    this.begin(info, "", Array.isArray(info.messages) ? info.messages : undefined);
  }

  /** The session exists: header, notes, the resumed conversation, state. */
  private begin(info: any, fallbackModel: string, resumedMessages?: any[]): void {
    const project = info.project ?? {};
    const model = String(info.model || fallbackModel);
    const mode = MODES.includes(info.mode) ? (info.mode as Mode) : "build";
    this.modeConfirmed = mode;
    this.write(
      fmtHeader(
        { version: this.version, model, mode, root: String(project.root ?? ""), branch: project.branch, home: this.o.home },
        this.o.width(),
      ),
    );
    if (project.instruction_file) this.note(`${project.instruction_file} loaded`);
    if (project.is_git === false) this.note("not a git repository");
    this.checkpointNote(info.checkpoints?.note);
    if (resumedMessages) this.o.onResume?.(resumedMessages); // before any queued prompt is written
    this.set({
      phase: "idle",
      error: null,
      picker: null,
      mode,
      model,
      sessionId: String(info.session_id ?? ""),
      ctx: { used: 0, limit: Number(info.context_length) || 0 },
    });
    this.drainQueue();
  }

  private checkpointNote(text: unknown): void {
    if (typeof text !== "string" || !text || this.shownNotes.has(text)) return;
    this.shownNotes.add(text);
    this.note(text);
  }

  private failStart(e: unknown): void {
    if (this.state.phase === "error") return; // already reported
    const msg = errText(e);
    this.error(msg);
    this.set({ phase: "error", error: msg, activity: null, permission: null, picker: null });
  }

  // ── prompts ────────────────────────────────────────────────────────────────

  submit(text: string): void {
    if (text.trim() === "") return;
    const dead = this.o.bridge.deadError();
    if (dead) return this.bridgeGone(dead);
    const { phase } = this.state;
    if (!this.state.sessionId && phase !== "starting") {
      this.error(
        phase === "picker" ? "no session yet — choose one first" : "no session — fix the problem above, or /exit",
      );
      return;
    }
    // Always behind what is already waiting; it goes out at once only when
    // nothing is in the way (a turn, the session starting, a mode change).
    this.set({ queue: [...this.state.queue, text] });
    this.drainQueue();
  }

  private bridgeGone(dead: Error): void {
    this.error(`the bridge is gone — restart aihub-code (${dead.message})`);
    this.set({ phase: "error", error: dead.message, activity: null, permission: null });
  }

  private drainQueue(): void {
    if (this.turn || this.modeBusy || this.state.phase === "starting") return;
    if (!this.state.sessionId || this.o.bridge.deadError()) return;
    const [next, ...rest] = this.state.queue;
    if (next === undefined) return;
    this.set({ queue: rest });
    this.sendTurn(next);
  }

  private sendTurn(text: string): void {
    this.write([[], ...fmtUser(text, this.o.width())]);
    this.turnsSent++;
    const turn: Turn = { handle: null, cancelled: false, streamer: new MarkdownStreamer(this.o.width()) };
    this.turn = turn;
    this.set({ phase: "running", activity: { label: "thinking…", since: this.now() } });
    turn.handle = this.o.bridge.stream("code.turn", { text }, (event, data) => this.onEvent(turn, event, data));
    turn.handle.done.then(
      () => this.onDone(turn),
      (err) => this.onFail(turn, err),
    );
  }

  // ── turn events ────────────────────────────────────────────────────────────

  private onEvent(turn: Turn, event: string, data: any): void {
    if (this.turn !== turn) return;
    if (turn.cancelled) {
      // The engine may still be waiting on a prompt that slipped past the
      // cancel: refuse it, so it never blocks the turn's end.
      if (event === "permission_request") this.denyUnseen(turn, data);
      return;
    }
    const width = this.o.width();
    switch (event) {
      case "text":
        this.write(turn.streamer.feed(String(data.text ?? "")));
        this.activity("writing…");
        break;
      case "thinking":
        this.activity("thinking…");
        break;
      case "tool_call": {
        this.flush(turn);
        const ev = data as ToolCallEvent;
        this.write(fmtToolCall(ev, width));
        this.activity(activityFor(ev));
        break;
      }
      case "tool_result":
        this.flush(turn);
        this.write(fmtToolResult(data as ToolResultEvent, width));
        this.activity("thinking…");
        break;
      case "code_diff":
        this.flush(turn);
        this.write(fmtDiff(data as DiffEvent, width));
        break;
      case "code_todos": {
        this.flush(turn);
        const todos: TodoItem[] = Array.isArray(data.todos) ? data.todos : [];
        this.write(fmtTodos(todos, width));
        this.set({ todos });
        break;
      }
      case "code_compaction":
        this.flush(turn);
        this.write(fmtCompaction(data as CompactionEvent, this.state.ctx.limit || undefined));
        break;
      case "code_context":
        this.set({ ctx: { used: Number(data.used) || 0, limit: Number(data.limit) || this.state.ctx.limit } });
        break;
      case "code_checkpoint":
        this.flush(turn);
        this.checkpointNote(data.note);
        break;
      case "chat_error":
        this.flush(turn);
        this.error(String(data.message ?? "error"));
        break;
      case "permission_request":
        this.flush(turn);
        this.set({
          phase: "permission",
          activity: null,
          permission: {
            requestId: turn.handle!.id,
            permissionId: typeof data.permission_id === "number" ? data.permission_id : null,
            name: String(data.name ?? ""),
            arguments: data.arguments && typeof data.arguments === "object" ? data.arguments : {},
            diff: data.diff ?? null,
            suggestedRule: data.suggested_rule ?? null,
            mode: String(data.mode ?? ""),
            reason: String(data.reason ?? ""),
          },
        });
        break;
      // usage, round, final, knowledge, ...: nothing to show.
    }
  }

  private flush(turn: Turn): void {
    this.write(turn.streamer.flush());
  }

  /** The activity line, unless a prompt is open (it replaces the line). */
  private activity(label: string): void {
    if (this.state.permission) return;
    const cur = this.state.activity;
    if (cur?.label === label) return;
    this.set({ activity: { label, since: this.now() } });
  }

  private denyUnseen(turn: Turn, data: any): void {
    const extra = typeof data.permission_id === "number" ? { permission_id: data.permission_id } : {};
    this.o.bridge.permission(turn.handle!.id, false, extra);
  }

  private onDone(turn: Turn): void {
    if (this.turn !== turn) return;
    if (!turn.cancelled) this.flush(turn);
    this.turn = null;
    this.set({ phase: "idle", activity: null, permission: null });
    this.drainQueue();
  }

  private onFail(turn: Turn, err: unknown): void {
    if (this.turn !== turn) return;
    if (!turn.cancelled) this.flush(turn);
    this.turn = null;
    const msg = errText(err);
    this.error(msg);
    if (this.o.bridge.deadError()) {
      // The queue stays: it is the user's typing, and it is still shown.
      this.set({ phase: "error", error: msg, activity: null, permission: null });
    } else {
      this.set({ phase: "idle", activity: null, permission: null });
      this.drainQueue(); // what was typed meanwhile still goes out, in order
    }
  }

  // ── permission, cancel ─────────────────────────────────────────────────────

  /** Answer the open prompt. `permissionId` is the id of the prompt the user
   *  was looking at: an answer to a prompt that has since been replaced is dropped. */
  answer(choice: PermissionChoice, permissionId: number | null): void {
    const p = this.state.permission;
    if (!p || !this.turn) return;
    if (permissionId !== p.permissionId) return;
    const extra: Record<string, unknown> = {};
    if (p.permissionId !== null) extra.permission_id = p.permissionId;
    let allow = true;
    if (choice === "always" && p.suggestedRule) extra.remember = "project";
    if (typeof choice === "object") {
      allow = false;
      const message = choice.no?.trim();
      if (message) extra.message = message;
    }
    this.o.bridge.permission(p.requestId, allow, extra);
    this.set({
      phase: "running",
      permission: null,
      activity: { label: allow ? `running ${p.name}…` : "thinking…", since: this.now() },
    });
  }

  /** Interrupt the running turn (Esc / Ctrl+C). The engine finishes on its own
   *  time, so the phase stays "running" (activity "interrupting…") until `done`;
   *  events meanwhile are dropped, and a second cancel does nothing. */
  cancel(): void {
    const turn = this.turn;
    if (!turn || turn.cancelled) return;
    this.flush(turn);
    turn.cancelled = true;
    turn.handle?.cancel();
    this.note(`  ${G.elbow} interrupted`);
    this.set({ activity: { label: "interrupting…", since: this.now() }, permission: null });
  }

  // ── mode ───────────────────────────────────────────────────────────────────

  cycleMode(): void {
    this.setMode(MODES[(MODES.indexOf(this.state.mode) + 1) % MODES.length]!);
  }

  setMode(mode: Mode): void {
    if (!this.state.sessionId || mode === this.state.mode) return;
    if (this.turn) {
      this.note("mode can change when the turn is done");
      return;
    }
    this.set({ mode });
    this.modeWanted = mode;
    if (!this.modeBusy) void this.syncMode();
  }

  /** One code.mode at a time, always for the latest wanted mode. */
  private async syncMode(): Promise<void> {
    this.modeBusy = true;
    try {
      while (this.modeWanted !== null && this.modeWanted !== this.modeConfirmed) {
        const wanted = this.modeWanted;
        this.modeWanted = null;
        try {
          const r = await this.o.bridge.request<{ mode: Mode }>("code.mode", { mode: wanted });
          this.modeConfirmed = MODES.includes(r.mode) ? r.mode : wanted;
          // Nothing newer to send (or the user came back to this very mode).
          if (this.modeWanted === null || this.modeWanted === this.modeConfirmed) {
            this.modeWanted = null;
            this.note(`mode: ${this.modeConfirmed}`);
            this.set({ mode: this.modeConfirmed });
          }
        } catch (e) {
          this.modeWanted = null;
          this.error(errText(e));
          this.set({ mode: this.modeConfirmed });
        }
      }
    } finally {
      this.modeBusy = false;
      this.drainQueue(); // a prompt typed meanwhile was waiting for the engine
    }
  }

  // ── commands, exit ─────────────────────────────────────────────────────────

  async runCommand(name: string, arg: string): Promise<void> {
    const fn = this.o.commands?.[name];
    if (!fn) {
      this.note(`unknown command /${sanitize(name)} — /help lists them`);
      return;
    }
    try {
      await fn(this, arg);
    } catch (e) {
      this.error(errText(e));
    }
  }

  exit(): void {
    if (this.exited) return;
    this.exited = true;
    if (this.turn) this.cancel();
    if (this.state.sessionId && (this.turnsSent > 0 || this.resumed)) {
      this.note(`Resume this session: aihub-code --resume ${this.state.sessionId}`);
    }
    this.o.onExit?.();
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "fix calc (3 turns, 2026-10-26 10:00)". */
function sessionLabel(s: any): string {
  const when = String(s.updated ?? "").replace("T", " ").slice(0, 16);
  const turns = Number(s.turns) || 0;
  const title = String(s.title || "(no title)");
  return `${title} (${turns} turn${turns === 1 ? "" : "s"}${when ? `, ${when}` : ""})`;
}

function activityFor(ev: ToolCallEvent): string {
  if (SHELL_TOOLS.has(ev.name)) {
    const cmd = typeof ev.arguments?.command === "string" ? ev.arguments.command : "";
    const first = sanitize(stripCR(cmd.split("\n")[0] ?? "")).trim();
    if (first) return `running ${first}…`;
  }
  return `running ${sanitize(ev.name)}…`;
}
