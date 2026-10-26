/**
 * A scripted stand-in for BridgeClient, mirroring how the real one behaves:
 * one-shot answers come from `answers`, a stream is a handle the test drives
 * (emit / finish / fail), and control messages land in `controls` in the
 * shape the engine receives them. Test-only.
 */
import type { Bridge } from "./controller";
import type { StreamHandle } from "../bridge/client";

export type Call = { method: string; params: Record<string, unknown> };
export type Answer = unknown | Error | ((params: Record<string, unknown>) => unknown);

export interface MockStream {
  id: number;
  method: string;
  params: Record<string, unknown>;
  emit(event: string, data?: Record<string, unknown>): void;
  finish(data?: Record<string, unknown>): void;
  fail(err: Error): void;
}

export class MockBridge implements Bridge {
  calls: Call[] = [];
  controls: { method: string; params?: Record<string, unknown> }[] = [];
  streams: MockStream[] = [];
  answers: Record<string, Answer> = {};
  version = "0.2.0";
  readyError: Error | null = null;
  dead: Error | null = null;
  private nextId = 1;
  private deathListeners: ((err: Error) => void)[] = [];
  private open = new Set<MockStream>();

  ready(): Promise<{ version: string }> {
    return this.readyError ? Promise.reject(this.readyError) : Promise.resolve({ version: this.version });
  }

  deadError(): Error | null {
    return this.dead;
  }

  onDead(fn: (err: Error) => void): void {
    this.deathListeners.push(fn);
  }

  /** The bridge process dies, as BridgeClient reports it: what is pending
   *  rejects (seen a microtask later), the death listeners hear it at once. */
  die(err: Error): void {
    this.dead = err;
    for (const s of [...this.open]) s.fail(err);
    for (const fn of this.deathListeners) fn(err);
  }

  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (this.dead) return Promise.reject(this.dead);
    const a = this.answers[method];
    if (a instanceof Error) return Promise.reject(a);
    const v = typeof a === "function" ? (a as (p: Record<string, unknown>) => unknown)(params) : a;
    return v instanceof Error ? Promise.reject(v) : Promise.resolve((v ?? {}) as T);
  }

  stream(method: string, params: Record<string, unknown>, onEvent: (event: string, data: any) => void): StreamHandle {
    const id = this.nextId++;
    this.calls.push({ method, params });
    let resolve!: (v: any) => void;
    let reject!: (e: Error) => void;
    const done = new Promise<any>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    if (this.dead) reject(this.dead);
    const s: MockStream = {
      id,
      method,
      params,
      emit: (event, data = {}) => onEvent(event, data),
      finish: (data = {}) => {
        this.open.delete(s);
        resolve(data);
      },
      fail: (err) => {
        this.open.delete(s);
        reject(err);
      },
    };
    this.streams.push(s);
    if (!this.dead) this.open.add(s);
    return { id, done, cancel: () => this.send({ method: "chat.cancel", params: { request_id: id } }) };
  }

  send(control: { method: string; params?: Record<string, unknown> }): void {
    this.controls.push(control);
  }

  permission(requestId: number, allow: boolean, extra: Record<string, unknown> = {}): void {
    this.send({ method: "chat.permission", params: { request_id: requestId, allow, ...extra } });
  }

  /** The calls to one method, in order. */
  to(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  get lastStream(): MockStream {
    return this.streams[this.streams.length - 1]!;
  }
}
