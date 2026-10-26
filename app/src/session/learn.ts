/**
 * Automatic memory, as AIhub v1.5.0's ChatScreen does it (learnNow,
 * scheduleLearning, endSessionLearning; ChatScreen 168–207): once the user
 * has been quiet for a while after a reply, the engine's `memory.learn` looks
 * at the user's messages it hasn't seen yet (the cursor) and the changes it
 * makes are written as AIhub's memory lines, with `/memory undo` to take
 * them back.
 *
 * aihub-code adds: it learns after code turns too, and it keeps to one model
 * request at a time — it waits while a turn (or a scheduled task) runs, and
 * its own requests go one after another.
 *
 * The per-conversation state lives here (the cursor, the timer, the code
 * conversation's user messages); the controller holds one Learner and tells
 * it when a turn ends (schedule / codeTurn) and when a conversation ends (reset).
 */
import { G } from "../glyphs";
import type { Line } from "../scrollback";
import { palette } from "../theme";
import { sanitize, stripCR, wrapSpans } from "../width";
import type { Bridge } from "./controller";
import type { ChatMessage } from "./hubChat";

/** One change memory made (bridge _change_dict), or one an undo reverted. */
export interface MemoryChange {
  id?: number | string;
  op: "add" | "update" | "forget" | "undo";
  topic: string;
  before?: string | null;
  after?: string | null;
}

export interface LearnerOptions {
  /** A turn or a scheduled task is using the model: learning waits. */
  isBusy?: () => boolean;
  /** What memory changed (written as notes). */
  onChanges?: (changes: MemoryChange[]) => void;
  /** "Learning memory failed: …", once per distinct failure. */
  onError?: (text: string) => void;
}

interface Snapshot {
  messages: ChatMessage[];
  model: string;
  session: string;
}

/** What the code agent writes into its session as a user message that the
 *  user never typed (aihub_code compaction.SUMMARY_PREFIX, session.UNDONE_NOTE). */
const NOT_THE_USERS = [/^\[Conversation summary\]/, /^\[The user undid the file changes of that turn\.\]$/];

/** A code turn's own user message, as memory.learn reads messages (role and
 *  content only): the last user message of the session's messages that the
 *  user wrote. Null when there is none. */
export function turnUserMessage(messages: unknown): ChatMessage | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object" || m.role !== "user" || typeof m.content !== "string") continue;
    if (NOT_THE_USERS.some((re) => re.test(m.content))) continue;
    return { role: "user", content: m.content };
  }
  return null;
}

const one = (t: unknown): string => sanitize(stripCR(String(t ?? ""))).replace(/\s*\n\s*/g, " ");

/** AIhub's memory line (ChatLog MemoryItem):
 *    ✻ Remembered · Editor — VS Code  (was: Neovim)   /memory undo */
export function fmtMemoryChange(c: MemoryChange, width: number): Line[] {
  const verb = c.op === "forget" ? "Forgot" : c.op === "undo" ? "Undid" : "Remembered";
  const value = c.op === "forget" ? "" : ` — ${c.after == null ? "(removed)" : one(c.after)}`;
  const was = c.before && c.op !== "undo" ? `  (was: ${one(c.before)})` : "";
  return wrapSpans(
    [
      { text: `${G.memory} `, fg: palette.accent },
      { text: `${verb} · ${one(c.topic)}${value}${was}`, dim: true },
      ...(c.op !== "undo" ? [{ text: "   /memory undo", dim: true }] : []),
    ],
    Math.max(1, width),
    { indent: "  " },
  );
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Learner {
  /** The conversation's cursor: a new object per conversation, so a request
   *  of the one before can't move this one's (AIhub's learnSession check). */
  private ref = { cursor: 0 };
  /** What the next learn reads: the conversation as the last turn left it. */
  private snap: Snapshot | null = null;
  /** The code conversation's user messages, one per turn (the session's own
   *  messages shrink on /undo and /compact; this only grows). */
  private codeLog: ChatMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Learn requests, one after another. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private lastError = "";

  constructor(
    private readonly bridge: Pick<Bridge, "request">,
    private readonly idleMs: number = Number(process.env.AIHUB_LEARN_IDLE_MS) || 20_000,
    private readonly o: LearnerOptions = {},
  ) {}

  /** After a reply: learn once the user has been quiet for idleMs (a new
   *  reply starts the wait again). */
  schedule(messages: ChatMessage[], model: string, session: string): void {
    this.remember(messages, model, session);
    this.arm();
  }

  /** The conversation changed without a reply (an interrupted turn): the next
   *  learn reads it, but none is scheduled for it. */
  remember(messages: ChatMessage[], model: string, session: string): void {
    this.snap = { messages: [...messages], model, session };
  }

  /** A code turn ended: its user message joins the code conversation;
   *  `schedule` false for an interrupted turn. */
  codeTurn(messages: unknown, model: string, session: string, schedule: boolean): void {
    const m = turnUserMessage(messages);
    if (m) this.codeLog.push(m);
    if (schedule) this.schedule(this.codeLog, model, session);
    else this.remember(this.codeLog, model, session);
  }

  /** The code conversation's user messages (for /memoryadd). */
  codeMessages(): ChatMessage[] {
    return [...this.codeLog];
  }

  /** Learn now from what the conversation has (still after a running turn). */
  now(): void {
    this.cancelTimer();
    const s = this.snap;
    if (this.closed || !s || !s.model || !s.messages.some((m) => m.role === "user")) return;
    const ref = this.ref;
    this.chain = this.chain.then(() => this.learn(s, ref));
  }

  /** A conversation ends (new session, /clear, model switch, kind switch,
   *  history load): learn from what's left of it, then count afresh.
   *  `nextCursor`: the user messages the next conversation already has
   *  (a loaded one was there to learn from before). */
  reset(nextCursor = 0): void {
    this.now();
    this.ref = { cursor: nextCursor };
    this.snap = null;
    this.codeLog = [];
  }

  /** Leaving: nothing more goes out. */
  cancel(): void {
    this.closed = true;
    this.cancelTimer();
  }

  private arm(): void {
    this.cancelTimer();
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Neither next to a reply nor next to a scheduled task: wait again.
      if (this.busy()) return this.arm();
      this.now();
    }, this.idleMs);
    this.timer.unref?.();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private busy(): boolean {
    return this.o.isBusy?.() === true;
  }

  /** A learn asked for at a conversation's end may meet a turn that started
   *  since: it goes out when the model is free. */
  private async whenIdle(): Promise<void> {
    while (!this.closed && this.busy()) await sleep(Math.min(this.idleMs, 500));
  }

  private async learn(s: Snapshot, ref: { cursor: number }): Promise<void> {
    await this.whenIdle();
    if (this.closed) return;
    try {
      const d = await this.bridge.request<{ changes?: MemoryChange[]; cursor?: number }>("memory.learn", {
        messages: s.messages,
        cursor: ref.cursor,
        model: s.model,
        session: s.session,
      });
      if (typeof d?.cursor === "number") ref.cursor = d.cursor;
      const changes = Array.isArray(d?.changes) ? d.changes : [];
      if (!changes.length) return;
      // Not into the middle of a reply that started meanwhile.
      await this.whenIdle();
      if (!this.closed) this.o.onChanges?.(changes);
    } catch (e) {
      const text = `Learning memory failed: ${errText(e)}`;
      if (this.closed || text === this.lastError) return;
      this.lastError = text;
      this.o.onError?.(text);
    }
  }
}
