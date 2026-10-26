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
import type { CompactionEvent, DiffEvent, TodoItem, ToolCallEvent, ToolResultEvent, UndoPlan } from "../transcript/events";
import {
  fmtCompaction,
  fmtCommandEcho,
  fmtDiff,
  fmtDivider,
  fmtError,
  fmtHeader,
  fmtNote,
  fmtTodos,
  fmtUndoConflicts,
  fmtUndoPlan,
  fmtToolCall,
  fmtToolResult,
  fmtUser,
  undoSummary,
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
  /** Called once if the bridge process dies (never for a close on purpose). */
  onDead?(fn: (err: Error) => void): void;
}

/** Where a model runs: on the Ollama server, or behind a provider's API. */
export type Backend = "ollama" | "api";

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

/** A yes/no question the footer asks in place of the input box (`/undo`). */
export interface ConfirmState {
  question: string;
  /** One line above the question, e.g. what would be restored. */
  detail: string;
  /** The undo goes ahead over files that changed after the turn. */
  force: boolean;
}

/** AIhub's windows, opened as panels above the prompt. */
export type PanelId =
  | "memory"
  | "models"
  | "hardware"
  | "agents"
  | "skills"
  | "mcp"
  | "knowledge"
  | "schedule"
  | "missed"
  | "history"
  | "settings"
  | "theme"
  | "temperature"
  | "palette"
  | "help";

export interface ControllerState {
  phase: Phase;
  mode: Mode;
  model: string;
  /** How the model is reached, and the name the engine streams it under. */
  backend: Backend;
  streamModel: string;
  /** The sampling temperature (the engine's config; `/temp`). */
  temperature: number;
  sessionId: string;
  ctx: { used: number; limit: number };
  activity: { label: string; since: number } | null;
  permission: PermissionState | null;
  queue: string[];
  todos: TodoItem[];
  /** The message behind phase "error". */
  error: string | null;
  picker: PickerState | null;
  confirm: ConfirmState | null;
  /** The AIhub window open in place of the prompt, or null. `viewOnly`: the
   *  models window opened while a turn ran (look, don't pick). */
  panel: { id: PanelId; arg?: string; viewOnly?: boolean } | null;
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
  /** How long exit() waits for an interrupted turn to end (the engine saves
   *  the session at the turn's end) before it goes anyway. */
  exitGraceMs?: number;
}

/** `gemma4:cloud`, `gpt-oss:120b-cloud`: runs on ollama.com. */
const CLOUD_TAG = /:(?:[^:]*-)?cloud$/;
/** `qwen2.5-coder` is `qwen2.5-coder:latest`. */
const withTag = (name: string): string => (name.includes(":") ? name : `${name}:latest`);

interface BeginOptions {
  /** The model's backend and stream name (a model picked from the API list). */
  backend?: Backend;
  streamModel?: string;
  /** Write a divider instead of the header: the conversation continues below. */
  divider?: "clear" | "model";
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
    backend: "ollama",
    streamModel: "",
    temperature: 0.7,
    sessionId: "",
    ctx: { used: 0, limit: 0 },
    activity: null,
    permission: null,
    queue: [],
    todos: [],
    error: null,
    picker: null,
    confirm: null,
    panel: null,
  };
  private listeners = new Set<() => void>();
  private turn: Turn | null = null;
  private version = "";
  private startArgs: Pick<Args, "mcp" | "kb" | "model"> & { mode: Mode } = { mode: "build", mcp: [], kb: [] };
  private shownNotes = new Set<string>();
  private turnsSent = 0;
  private resumed = false;
  private exited = false;
  // Mode changes: the engine takes one at a time, so quick presses coalesce.
  private modeConfirmed: Mode = "build";
  private modeWanted: Mode | null = null;
  private modeBusy = false;
  // An undo is in flight (preview or confirm): no turn may start meanwhile.
  private undoBusy = false;
  // A picker's list is being fetched (/model, /sessions): same.
  private listing = false;
  // Where Esc in a command's picker goes back to, when there is no session to
  // go back to (after a failed start: "error"). Null for start-up pickers.
  private pickerBack: Phase | null = null;

  constructor(private readonly o: ControllerOptions) {
    // A bridge that dies between turns is said at once, not at the next Enter.
    o.bridge.onDead?.((err) => this.bridgeDied(err));
  }

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
    // The models window opened view-only while a turn ran is a normal one
    // again once the turn is over: this is the one source of "view only".
    const { panel, phase } = this.state;
    if (panel?.viewOnly && phase !== "running" && phase !== "permission") {
      this.state = { ...this.state, panel: { id: panel.id, ...(panel.arg === undefined ? {} : { arg: panel.arg }) } };
    }
    for (const fn of [...this.listeners]) fn();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The terminal width now (commands wrap their own lines). */
  columns(): number {
    return this.o.width();
  }

  write(lines: Line[]): void {
    if (lines.length) this.o.sink.write(lines);
  }

  error(text: string): void {
    this.write(fmtError(text, this.o.width()));
  }

  note(text: string): void {
    this.write(fmtNote(text, this.o.width()));
  }

  /** A bridge call for the commands. */
  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.o.bridge.request<T>(method, params);
  }

  // ── start-up ───────────────────────────────────────────────────────────────

  async start(args: Args): Promise<void> {
    this.startArgs = { mode: args.mode ?? "build", mcp: args.mcp, kb: args.kb, model: args.model };
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

  /** Picker answer: a model or a session to resume (at start-up, or from /model
   *  and /sessions). Esc with a live session just closes the picker; before
   *  the first session it means "no choice": a new session on the default
   *  model, or leaving when there is no model. */
  async pick(id: string | null): Promise<void> {
    const picker = this.state.picker;
    if (!picker) return;
    const live = this.state.sessionId !== "";
    const back = this.pickerBack;
    this.pickerBack = null;
    if (id === null && live) {
      this.set({ picker: null, phase: "idle" });
      this.drainQueue();
      return;
    }
    if (id === null && back !== null) {
      this.set({ picker: null, phase: back });
      return;
    }
    await this.replaceSession(async () => {
      if (picker.kind === "model") {
        if (id === null) return this.exit();
        // It came from the server's own list.
        await this.startSession(id, false, live ? { mode: this.state.mode, divider: "model" } : {});
      } else if (id === null) {
        const model = this.startArgs.model || (await this.o.bridge.request<Record<string, unknown>>("config.get", {})).default_chat_model;
        if (!model) return await this.pickModel();
        await this.startSession(String(model), true);
      } else {
        await this.resume(id);
      }
    });
  }

  /** "starting" while a session comes up: prompts typed meanwhile queue. If it
   *  fails, a live session stays as it was and the failure is just printed. */
  private async replaceSession(open: () => Promise<void>): Promise<void> {
    this.set({ picker: null, phase: "starting" });
    try {
      await open();
    } catch (e) {
      if (this.state.sessionId && !this.o.bridge.deadError()) {
        this.error(errText(e));
        this.set({ phase: "idle" });
        this.drainQueue();
      } else {
        this.failStart(e);
      }
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

  /** True only when the server's own list is known and lacks the model. Never
   *  blocks start-up: an empty or failed answer (the engine reports an offline
   *  server as an empty list) and cloud names (not listed locally until used)
   *  count as "unknown", and cloud.models is never asked (it can crawl the web). */
  private async modelMissing(model: string): Promise<boolean> {
    if (CLOUD_TAG.test(model)) return false;
    try {
      const { models } = await this.o.bridge.request<{ models?: { name: string }[] }>("models.installed", {});
      if (!Array.isArray(models) || models.length === 0) return false;
      const want = withTag(model);
      return !models.some((m) => withTag(String(m.name)) === want);
    } catch {
      return false;
    }
  }

  private openPicker(picker: PickerState, back: Phase | null = null): void {
    this.pickerBack = back;
    this.set({ phase: "picker", picker });
  }

  /** With `check`, a model missing from the server's installed list opens the
   *  picker instead; if that cannot be told, we go ahead and the turn reports it. */
  private async startSession(model: string, check: boolean, opts: BeginOptions & { mode?: Mode } = {}): Promise<void> {
    if (check && (await this.modelMissing(model))) return this.pickModel(model);
    const { mcp, kb } = this.startArgs;
    const info = await this.o.bridge.request("code.start", {
      cwd: this.o.cwd ?? process.cwd(),
      model,
      mode: opts.mode ?? this.startArgs.mode,
      mcp,
      knowledge: kb,
      ...(opts.backend ? { backend: opts.backend } : {}),
      ...(opts.streamModel ? { stream_model: opts.streamModel } : {}),
    });
    this.turnsSent = 0;
    this.resumed = false;
    this.begin(info, model, undefined, opts);
  }

  private async resume(sessionId: string): Promise<void> {
    const info = await this.o.bridge.request("code.resume", { cwd: this.o.cwd ?? process.cwd(), session_id: sessionId });
    this.turnsSent = 0;
    this.resumed = true;
    this.begin(info, "", Array.isArray(info.messages) ? info.messages : undefined);
  }

  /** The session exists: header (or a divider when the conversation goes on
   *  below an earlier one), notes, the resumed conversation, state. */
  private begin(info: any, fallbackModel: string, resumedMessages?: any[], opts: BeginOptions = {}): void {
    const project = info.project ?? {};
    const model = String(info.model || fallbackModel);
    const mode = MODES.includes(info.mode) ? (info.mode as Mode) : "build";
    this.modeConfirmed = mode;
    if (opts.divider) {
      this.write(fmtDivider(opts.divider === "model" ? `new session with ${model}` : "new session", this.o.width()));
    } else {
      this.write(
        fmtHeader(
          { version: this.version, model, mode, root: String(project.root ?? ""), branch: project.branch, home: this.o.home },
          this.o.width(),
        ),
      );
      if (project.instruction_file) this.note(`${project.instruction_file} loaded`);
      if (project.is_git === false) this.note("not a git repository");
    }
    this.checkpointNote(info.checkpoints?.note);
    if (resumedMessages) this.o.onResume?.(resumedMessages); // before any queued prompt is written
    this.set({
      phase: "idle",
      error: null,
      picker: null,
      mode,
      model,
      backend: info.backend === "api" ? "api" : "ollama",
      streamModel: String(info.stream_model || model),
      temperature: typeof info.temperature === "number" ? info.temperature : this.state.temperature,
      sessionId: String(info.session_id ?? ""),
      ctx: { used: 0, limit: Number(info.context_length) || 0 },
      todos: [],
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

  /** A line from the prompt: `/command args` runs at once (never queued);
   *  `//text` is a prompt that begins with a slash; anything else is a prompt. */
  submit(text: string): void {
    // Leaving: nothing typed during the exit wait may start new work.
    if (this.exited || text.trim() === "") return;
    const head = text.trimStart();
    if (head.startsWith("//")) text = head.slice(1);
    else if (head.startsWith("/")) {
      const m = /^\/(\S*)\s*([\s\S]*)$/.exec(head.trimEnd())!;
      this.write(fmtCommandEcho(head, this.o.width()));
      void this.runCommand(m[1]!.toLowerCase(), m[2]!);
      return;
    }
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

  /** The client's death hook. A turn reports it itself (its stream fails),
   *  and so does a start-up (failStart): only a quiet bridge needs the line. */
  private bridgeDied(err: Error): void {
    if (this.exited || this.turn || this.state.phase === "error" || this.state.phase === "starting") return;
    this.bridgeGone(err);
  }

  private drainQueue(): void {
    if (this.exited || this.turn || this.modeBusy || this.undoBusy || this.listing) return;
    if (this.state.confirm || this.state.picker || this.state.phase === "starting") return;
    // A turn under an open panel would squeeze into the row above it, and a
    // permission prompt would unmount the window: the queue waits for closePanel.
    if (this.state.panel) return;
    if (!this.state.sessionId || this.o.bridge.deadError()) return;
    const [next, ...rest] = this.state.queue;
    if (next === undefined) return;
    this.set({ queue: rest });
    this.sendTurn(next);
  }

  private sendTurn(text: string): void {
    this.write([[], ...fmtUser(text, this.o.width())]);
    this.turnsSent++;
    this.startStream("code.turn", { text }, "thinking…");
  }

  /** A streaming call the engine runs on the session (a turn, a compaction):
   *  one at a time, cancellable, its events drawn by onEvent. */
  private startStream(method: string, params: Record<string, unknown>, label: string): void {
    const turn: Turn = { handle: null, cancelled: false, streamer: new MarkdownStreamer(this.o.width()) };
    this.turn = turn;
    this.set({ phase: "running", activity: { label, since: this.now() } });
    turn.handle = this.o.bridge.stream(method, params, (event, data) => this.onEvent(turn, event, data));
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
        if (typeof data.after === "number") this.set({ ctx: { ...this.state.ctx, used: data.after } });
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
    // What was typed behind the turn was written for a plan the user just
    // stopped: it does not go out on its own (Up brings it back).
    const n = this.state.queue.length;
    if (n > 0) this.note(`dropped ${n} queued prompt${n === 1 ? "" : "s"}`);
    this.set({ phase: "running", activity: { label: "interrupting…", since: this.now() }, permission: null, queue: [] });
  }

  // ── mode ───────────────────────────────────────────────────────────────────

  cycleMode(): void {
    this.setMode(MODES[(MODES.indexOf(this.state.mode) + 1) % MODES.length]!);
  }

  setMode(mode: Mode): void {
    if (!this.state.sessionId || mode === this.state.mode) return;
    // code.mode would race code.start / code.undo for the engine's session.
    const wait = this.turn
      ? "mode can change when the turn is done"
      : this.state.phase === "starting"
        ? "mode can change when the session is ready"
        : this.undoBusy || this.state.confirm
          ? "mode can change once the undo is done"
          : this.listing
            ? "mode can change when the list has loaded"
            : null;
    if (wait) {
      this.note(wait);
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

  // ── panels ─────────────────────────────────────────────────────────────────

  /** Open an AIhub window in place of the prompt. Not while a turn runs, asks
   *  for a permission or a picker is open: the window would take their keys.
   *  The one exception is the models window while a turn runs: it opens view
   *  only (no picking until the turn is over), and a permission prompt that
   *  comes meanwhile is drawn in its place until it is answered. */
  openPanel(id: PanelId, arg?: string): boolean {
    const { phase } = this.state;
    const viewOnly = id === "models" && phase === "running";
    if (!viewOnly && (phase === "running" || phase === "permission" || phase === "picker")) {
      this.note("Finish or interrupt the current turn first (Esc).");
      return false;
    }
    this.set({ panel: { id, ...(arg === undefined ? {} : { arg }), ...(viewOnly ? { viewOnly } : {}) } });
    return true;
  }

  /** Close the open window; a non-empty `result` is said as a note, and what
   *  was queued meanwhile goes out. */
  closePanel(result?: string): void {
    if (!this.state.panel) return;
    this.set({ panel: null });
    if (result) this.note(result);
    this.drainQueue();
  }

  // ── commands, exit ─────────────────────────────────────────────────────────

  async runCommand(name: string, arg: string): Promise<void> {
    if (this.exited) return;
    const fn = this.o.commands?.[name];
    if (!fn) {
      this.note(`unknown command /${sanitize(name)} \u2014 /help lists them`);
      // `/home/alex/x.py is broken` was meant as a prompt.
      if (name.includes("/")) this.note("to send text that starts with /, start it with //");
      return;
    }
    try {
      await fn(this, arg);
    } catch (e) {
      // A bridge that died meanwhile has had its red line (bridgeDied).
      if (this.o.bridge.deadError() && this.state.phase === "error") return;
      this.error(errText(e));
    }
  }

  /** For commands that need a session; says so when there is none. */
  requireSession(): boolean {
    if (this.state.sessionId) return true;
    this.note("no session yet");
    return false;
  }

  /** For commands that change or replace the session: only between turns. */
  private canSwitch(): boolean {
    const { phase, confirm, picker } = this.state;
    if (phase === "starting") {
      this.note("wait until the session is ready");
      return false;
    }
    if (this.listing) {
      this.note("still loading the model list");
      return false;
    }
    if (picker) {
      this.note("choose or cancel the picker first");
      return false;
    }
    if (confirm) {
      this.note("answer the undo question first");
      return false;
    }
    if (this.turn || this.modeBusy || this.undoBusy || phase === "permission") {
      this.note("wait for the current turn to finish");
      return false;
    }
    return true;
  }

  /** `/mode`: the mode in effect, or a change to it. */
  mode(arg: string): void {
    if (!this.requireSession()) return;
    const want = arg.trim().toLowerCase();
    if (!want) {
      this.note(`mode: ${this.state.mode} (change it with /mode plan, /mode build or /mode auto)`);
    } else if (!MODES.includes(want as Mode)) {
      this.note(`unknown mode ${sanitize(want)} \u2014 use plan, build or auto`);
    } else if (want === this.state.mode) {
      this.note(`already in ${want} mode`);
    } else {
      this.setMode(want as Mode); // says "mode: x" once the engine has it
    }
  }

  /** `/todos`: the model's list, as the last `todo_write` left it. */
  async showTodos(): Promise<void> {
    if (!this.requireSession()) return;
    const { todos = [] } = await this.o.bridge.request<{ todos?: TodoItem[] }>("code.todos", {});
    this.set({ todos });
    this.write(fmtTodos(todos, this.o.width()));
  }

  /** `/compact`. */
  compact(): void {
    if (!this.requireSession() || !this.canSwitch()) return;
    this.startStream("code.compact", {}, "compacting\u2026");
  }

  /** `/undo`: show what the last turn changed, then ask. `force` goes over
   *  files that changed after the turn. */
  async undo(force: boolean): Promise<void> {
    if (!this.requireSession() || !this.canSwitch()) return;
    const width = this.o.width();
    this.undoBusy = true;
    try {
      let plan: UndoPlan;
      try {
        plan = normalizePlan(await this.o.bridge.request<UndoPlan>("code.undo", {}));
      } catch (e) {
        return this.undoFailed(e);
      }
      this.write(fmtUndoPlan(plan, width));
      if (plan.conflicts.length > 0) this.write(fmtUndoConflicts(plan, width, !force));
      if (plan.conflicts.length > 0 && !force) return;
      this.set({ confirm: { question: "Undo these changes? (y/N)", detail: undoSummary(plan, false), force } });
    } finally {
      this.undoBusy = false;
      this.drainQueue();
    }
  }

  /** The footer's answer to the open question. */
  async answerConfirm(yes: boolean): Promise<void> {
    const c = this.state.confirm;
    if (!c) return;
    if (!yes) {
      this.set({ confirm: null });
      this.note("nothing was undone");
      this.drainQueue();
      return;
    }
    this.undoBusy = true;
    this.set({ confirm: null });
    try {
      const plan = normalizePlan(await this.o.bridge.request<UndoPlan>("code.undo", c.force ? { confirm: true, force: true } : { confirm: true }));
      if (plan.applied) this.note(`undone: ${undoSummary(plan, true)}`);
      else if (plan.conflicts.length > 0) this.write(fmtUndoConflicts(plan, this.o.width()));
      else this.note("nothing was undone");
    } catch (e) {
      this.undoFailed(e);
    } finally {
      this.undoBusy = false;
      this.drainQueue();
    }
  }

  private undoFailed(e: unknown): void {
    const msg = errText(e);
    if (/^nothing to undo/.test(msg)) this.note("nothing to undo");
    else this.error(msg);
  }

  /** `/clear`: a new session on the same model, mode and opt-ins. */
  async clear(): Promise<void> {
    if (!this.requireSession() || !this.canSwitch()) return;
    await this.replaceSession(() => this.startSession(this.state.model, false, { mode: this.state.mode, divider: "clear" }));
  }

  /** `/model [name]`: a new session on another model (the old one stays
   *  resumable). Without a name: a picker of installed and cloud models. */
  async switchModel(name: string): Promise<void> {
    if (!this.canSwitch()) return;
    if (name) {
      await this.replaceSession(() => this.startSession(name, true, { mode: this.state.mode, divider: "model" }));
      return;
    }
    this.listing = true;
    this.set({ activity: { label: "loading models\u2026", since: this.now() } });
    try {
      this.openPickerIfFree({ kind: "model", title: "Choose a model", items: await this.modelChoices() });
    } finally {
      this.listing = false;
      this.set({ activity: null });
      this.drainQueue(); // prompts typed meanwhile (the picker, if open, still holds them)
    }
  }

  /** A model picked in the models window: a new code session on it, with its
   *  backend and stream name (the old session stays resumable). Chat and agent
   *  kinds switch in place instead (Task 5). */
  async useModel(choice: { name: string; backend: Backend; streamModel?: string }): Promise<void> {
    if (!this.canSwitch()) return;
    await this.replaceSession(() =>
      this.startSession(choice.name, false, {
        mode: this.state.mode,
        divider: "model",
        backend: choice.backend,
        streamModel: choice.streamModel,
      }),
    );
  }

  /** `/temp 0.7`, Temperature window, Settings: rounds to 0.1, saves it as the
   *  engine's default (the next turn reads it) and says so. */
  async setTemperature(t: number): Promise<void> {
    const v = Math.round(t * 10) / 10;
    try {
      await this.o.bridge.request("config.set", { patch: { temperature: v } });
    } catch (e) {
      this.error(`Saving the temperature: ${errText(e)}`);
      return;
    }
    this.set({ temperature: v });
    this.note(`Temperature \u2192 ${v.toFixed(1)}.`);
  }

  /** Nothing can start a turn while a list loads, but if one did, the picker
   *  would sit over it: drop it and say so. After a failed start ("error",
   *  bridge alive) the picker is the way out, and Esc comes back to "error". */
  private openPickerIfFree(picker: PickerState): void {
    const { phase } = this.state;
    const free = phase === "idle" || (phase === "error" && !this.o.bridge.deadError());
    if (this.turn || !free) {
      this.note("a turn started meanwhile \u2014 try again when it is done");
      return;
    }
    this.openPicker(picker, this.state.sessionId ? null : phase);
  }

  /** Installed models first, then cloud ones that are not installed yet. If
   *  the cloud list cannot be had, the installed ones are still offered. */
  private async modelChoices(): Promise<PickerItem[]> {
    const { models = [] } = await this.o.bridge.request<{ models?: { name: string }[] }>("models.installed", {});
    const items: PickerItem[] = models.map((m) => ({ id: String(m.name), label: String(m.name) }));
    try {
      const { models: cloud = [] } = await this.o.bridge.request<{ models?: { name: string; status?: string; installed?: boolean }[] }>("cloud.models", {});
      const have = new Set(items.map((i) => i.id));
      for (const m of cloud) {
        if (m.installed || have.has(m.name) || m.status === "retired" || m.status === "missing") continue;
        items.push({ id: String(m.name), label: `${m.name} (cloud${m.status === "free" || m.status === "paid" ? `, ${m.status}` : ""})` });
      }
    } catch {
      this.note("could not load the cloud list \u2014 showing installed models");
    }
    return items;
  }

  /** `/sessions`, `/resume`: pick one of this folder's earlier sessions. */
  async openSessions(): Promise<void> {
    if (!this.canSwitch()) return;
    this.listing = true;
    try {
      const { sessions = [] } = await this.o.bridge.request<{ sessions?: any[] }>("code.sessions", { cwd: this.o.cwd ?? process.cwd() });
      const others = sessions.filter((s) => String(s.id) !== this.state.sessionId);
      if (others.length === 0) {
        this.note("no earlier session in this folder");
        return;
      }
      this.openPickerIfFree({
        kind: "session",
        title: "Resume a session",
        items: others.map((s) => ({ id: String(s.id), label: sessionLabel(s) })),
      });
    } finally {
      this.listing = false;
      this.drainQueue();
    }
  }

  /** `/resume <id>`. */
  async resumeSession(id: string): Promise<void> {
    if (!this.canSwitch()) return;
    if (id === this.state.sessionId) {
      this.note("that's the current session");
      return;
    }
    await this.replaceSession(() => this.resume(id));
  }

  /** The session worth resuming: one something was said in (or that was itself
   *  resumed). Empty otherwise. The app prints the resume line from this once
   *  the terminal is restored. */
  resumableSessionId(): string {
    return this.state.sessionId && (this.turnsSent > 0 || this.resumed) ? this.state.sessionId : "";
  }

  /** Leave. A running turn is interrupted first, and its end awaited for a
   *  moment: the engine saves the session then, so --resume has the last
   *  prompt. A dead bridge rejects at once; a stuck one is not waited for. */
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    const turn = this.turn;
    if (!turn?.handle) return this.o.onExit?.();
    this.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((r) => (timer = setTimeout(r, this.o.exitGraceMs ?? 1500)));
    void Promise.race([turn.handle.done.then(noop, noop), grace]).then(() => {
      clearTimeout(timer);
      this.o.onExit?.();
    });
  }
}

const noop = (): void => {};

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function normalizePlan(p: Partial<UndoPlan> | null | undefined): UndoPlan {
  return {
    restore: list(p?.restore),
    delete: list(p?.delete),
    conflicts: list(p?.conflicts),
    shell_not_reverted: list(p?.shell_not_reverted),
    skipped: list(p?.skipped),
    applied: p?.applied === true,
  };
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
