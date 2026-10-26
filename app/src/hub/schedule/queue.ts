// Ported from AIhub-TUI v1.5.0 app/src/schedule/queue.ts.
/** Scheduled tasks waiting to run. One model request at a time: a task never
 *  starts while a chat turn streams or another task runs, and a task already
 *  waiting or running isn't queued twice (the 30 s check may report it again). */
export class TaskQueue {
  private waiting: Array<{ name: string; slot?: string }> = [];
  private current: string | null = null;

  /** False when the task is already waiting or running. */
  enqueue(name: string, slot?: string): boolean {
    if (this.current === name || this.waiting.some((t) => t.name === name)) return false;
    this.waiting.push({ name, slot });
    return true;
  }

  /** The task to start now, or null while the chat or another task is busy. */
  next(chatBusy: boolean): { name: string; slot?: string } | null {
    if (chatBusy || this.current) return null;
    return this.waiting.shift() ?? null;
  }

  start(name: string): void {
    this.current = name;
  }

  finish(): void {
    this.current = null;
  }

  get running(): string | null {
    return this.current;
  }

  get size(): number {
    return this.waiting.length;
  }
}
