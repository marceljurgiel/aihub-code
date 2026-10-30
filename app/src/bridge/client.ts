/**
 * BridgeClient — spawns the aihub-code bridge (aihub_code.bridge) and speaks
 * NDJSON over its stdio. call() (alias request()) is a one-shot request,
 * stream() a streaming one (code.turn, code.compact); cancel(), permission()
 * and send() write control messages.
 */
import { sanitizingReviver } from "./sanitize.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { homeDir } from "../home";
import { dirname, join } from "node:path";
import type { BridgeMessage, StreamHandlers } from "./types.ts";

type Pending = {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  handlers?: StreamHandlers;
};

type Env = Record<string, string | undefined>;

/** ~/.aihub/aihub-code-bridge.err.log, or AIHUB_CODE_ERR_LOG (the test preload
 *  points it at a temp file so test runs don't write into the user's log). */
export function bridgeErrLogPath(env: Env = process.env, home: string = homeDir(env)): string {
  return env.AIHUB_CODE_ERR_LOG || join(home, ".aihub", "aihub-code-bridge.err.log");
}

/** Append a line to the bridge error log (never throws). */
export function debugLog(msg: string) {
  try {
    const path = bridgeErrLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

/** The command that launches the Python bridge: AIHUB_CODE_BRIDGE (a JSON array
 *  of strings, set by `aihub-code` to its own interpreter), else python3. */
export function resolveBridgeCmd(env: Env = process.env): string[] {
  try {
    const v = JSON.parse(env.AIHUB_CODE_BRIDGE ?? "");
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x)) return v;
  } catch {
    /* fall through */
  }
  return ["python3", "-m", "aihub_code.bridge"];
}

/** A running stream: its request id, completion, and a cancel for it. */
const CLOSED = "the bridge was closed";

export type StreamHandle = { id: number; done: Promise<any>; cancel: () => void };

export class BridgeClient {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private readyWaiters: Array<{ resolve: (v: { version: string }) => void; reject: (e: Error) => void }> = [];
  /** Set once the bridge is gone (exit, or it never started): every request after
   *  that rejects at once with this error instead of waiting for a dead process. */
  private dead: Error | null = null;
  /** The ready banner, once received — kept so a late ready() still gets the
   *  engine version (it used to answer "?", shown as "core ?" in the footer). */
  private readyInfo: { version: string } | null = null;
  private cmd: string[];
  private deathListeners: Array<(err: Error) => void> = [];
  /** How long destroy() lets the bridge clean up after its stdin closes (it
   *  stops the agent's commands and the MCP servers) before it is killed. */
  exitGraceMs = 1500;

  constructor() {
    this.cmd = resolveBridgeCmd();
  }

  /** Launch the bridge subprocess and start reading its stdout. */
  start(): void {
    try {
      this.proc = Bun.spawn(this.cmd, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // The bridge inherits the launch folder as its cwd: that is the project.
        env: { ...process.env, PYTHONUTF8: "1" },
      }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    } catch (e) {
      // python3 missing, bad AIHUB_CODE_BRIDGE: same outcome as an early exit.
      debugLog(`bridge failed to start: ${e}`);
      this.fail(new Error(`could not start the bridge (${this.cmd[0]}) — see ${bridgeErrLogPath()}`));
      return;
    }
    this.readStdout();
    this.drainStderr();
    this.proc.exited.then((code) => {
      debugLog(`bridge exited code=${code}`);
      if (this.dead) return; // destroy() already closed us on purpose
      const where = this.readyInfo ? "bridge process exited" : "the bridge exited before it was ready";
      this.fail(new Error(`${where} (code ${code}) — see ${bridgeErrLogPath()}`));
    });
  }

  /** The bridge is gone: reject everything waiting, and everything that comes later. */
  private fail(err: Error) {
    this.dead = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const w of this.readyWaiters.splice(0)) w.reject(err);
    for (const fn of this.deathListeners.splice(0)) {
      try {
        fn(err);
      } catch (e) {
        debugLog(`death listener failed: ${e}`);
      }
    }
  }

  /** `fn` runs once if the bridge dies (exit, or it never started) — not when
   *  destroy() closes it on purpose. */
  onDead(fn: (err: Error) => void): void {
    this.deathListeners.push(fn);
  }

  /** Why the bridge is gone (exit, never started, closed), or null while it lives.
   *  An engine error rejects a request too; this tells the two apart. */
  deadError(): Error | null {
    return this.dead;
  }

  /** Wait until the bridge emits its `ready` banner; rejects if it dies first. */
  ready(): Promise<{ version: string }> {
    if (this.readyInfo) return Promise.resolve(this.readyInfo);
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  private async readStdout() {
    const stream = this.proc!.stdout as ReadableStream<Uint8Array>;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.handleLine(line);
      }
    }
  }

  private async drainStderr() {
    const stream = this.proc!.stderr as ReadableStream<Uint8Array>;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      if (text.trim()) debugLog(`[py] ${text.trimEnd()}`);
    }
  }

  private handleLine(line: string) {
    let msg: BridgeMessage;
    try {
      // Strip terminal control characters from every string the engine sends
      // (model output, tool results, file names…) before any of it renders.
      msg = JSON.parse(line, sanitizingReviver);
    } catch {
      debugLog(`bad JSON: ${line}`);
      return;
    }

    // Global events (id === null), e.g. the ready banner.
    if (msg.id === null || msg.id === undefined) {
      if (msg.event === "ready") {
        const info = { version: msg.data?.version ?? "?" };
        this.readyInfo = info;
        this.readyWaiters.splice(0).forEach((w) => w.resolve(info));
      }
      return;
    }

    const p = this.pending.get(msg.id);
    if (!p) return;

    if (msg.error !== undefined) {
      this.pending.delete(msg.id);
      p.reject(new Error(msg.error));
      return;
    }
    if (msg.done) {
      this.pending.delete(msg.id);
      p.resolve(msg.data ?? {});
      return;
    }
    if (msg.event && p.handlers?.onEvent) {
      p.handlers.onEvent(msg.event, msg.data ?? {});
    }
  }

  private write(obj: unknown) {
    const w = this.proc?.stdin;
    if (!w || this.dead) return;
    try {
      (w as any).write(JSON.stringify(obj) + "\n");
      (w as any).flush?.();
    } catch {
      /* the pipe closed under us; the exit handler rejects what is pending */
    }
  }

  /** One-shot request → resolves with the `done` payload. Alias of request(). */
  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>(method, params);
  }

  /** One-shot request → resolves with the `done` payload. */
  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (this.dead) return reject(this.dead);
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  /**
   * Streaming request → onEvent fires per event; the promise resolves with the
   * terminating `done` payload. `handlers` is an onEvent function or AIhub's
   * `{ onEvent }` object. The handle carries the id and a cancel().
   */
  stream(
    method: string,
    params: Record<string, unknown>,
    handlers: StreamHandlers | ((event: string, data: any) => void),
  ): StreamHandle {
    if (typeof handlers === "function") handlers = { onEvent: handlers };
    const id = this.nextId++;
    const done = new Promise<any>((resolve, reject) => {
      if (this.dead) return reject(this.dead);
      this.pending.set(id, { resolve, reject, handlers });
      this.write({ id, method, params });
    });
    return { id, done, cancel: () => this.cancel(id) };
  }

  /** Write a control message (no reply): chat.permission, chat.cancel. */
  send(control: { method: string; params?: Record<string, unknown> }) {
    this.write(control);
  }

  /** Cancel an in-flight streaming request (code.turn / code.compact). */
  cancel(requestId: number) {
    this.send({ method: "chat.cancel", params: { request_id: requestId } });
  }

  /** Answer a permission request (the engine ignores a stale permission_id). */
  permission(requestId: number, allow: boolean, extra: Record<string, unknown> = {}) {
    this.send({ method: "chat.permission", params: { request_id: requestId, allow, ...extra } });
  }

  /** Shut the bridge down: close its stdin, which ends it through its own
   *  cleanup (the agent's commands and the MCP servers go with it), and kill
   *  it only if it is still there after exitGraceMs. The timer is unref'd: it
   *  never keeps the app alive by itself. Requests still pending are dropped,
   *  not rejected: the caller is quitting, and a rejection nobody awaits would
   *  print an error. */
  destroy() {
    if (this.dead?.message === CLOSED) return;
    this.dead = new Error(CLOSED);
    this.pending.clear();
    this.readyWaiters.length = 0;
    this.deathListeners.length = 0;
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin?.end?.();
    } catch {
      /* ignore */
    }
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }, this.exitGraceMs);
    timer.unref?.();
    void proc.exited.then(() => clearTimeout(timer));
  }
}
