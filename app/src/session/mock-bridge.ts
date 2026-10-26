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

  ready(): Promise<{ version: string }> {
    return this.readyError ? Promise.reject(this.readyError) : Promise.resolve({ version: this.version });
  }

  deadError(): Error | null {
    return this.dead;
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
    this.streams.push({
      id,
      method,
      params,
      emit: (event, data = {}) => onEvent(event, data),
      finish: (data = {}) => resolve(data),
      fail: (err) => reject(err),
    });
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
