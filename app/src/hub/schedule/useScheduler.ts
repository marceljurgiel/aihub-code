// Ported from AIhub-TUI v1.5.0 app/src/schedule/useScheduler.ts.
import { useEffect, useRef, useState } from "react";
import { useBridge } from "../state/BridgeContext.tsx";
import { debugLog } from "../bridge/client.ts";
import { TaskQueue } from "./queue.ts";
import type { MissedTask } from "./types.ts";

/** How often the app asks the engine what is due. Tests shorten it. */
export const schedulerTiming = { checkMs: 30_000 };

/**
 * The clock for scheduled tasks — they run only while aihub-code is open. On start
 * it asks about slots missed while closed (one prompt per task), then checks
 * every 30 s and runs what is due, one at a time and never next to a chat turn.
 *
 * aihub-code glue: the host asks about missed slots (`askMissed`, its missed
 * panel, in place of AIhub's modal) and is told when a run starts, what it
 * streams and when it ends (`onStart` / `onEvent` / `onEnd`), so the task's
 * output prints in the transcript. The notes point to /schedule (no F7 here).
 */
export function useScheduler(opts: {
  /** A chat turn is streaming (the model is busy). */
  chatBusy: () => boolean;
  addSystem: (text: string, error?: boolean) => void;
  /** A task ended: the chat may send a message that waited for it. True
   *  when it did — the next task then waits for that reply. */
  onIdle: () => boolean;
  /** One prompt per missed task (AIhub: MissedTasksModal). */
  askMissed: (task: MissedTask, index: number, total: number) => Promise<"run" | "skip">;
  /** A run started; its stream's events; it ended (before the result note). */
  onStart?: (name: string) => void;
  onEvent?: (name: string, event: string, data: any) => void;
  onEnd?: (name: string) => void;
}) {
  const bridge = useBridge();
  const queue = useRef(new TaskQueue()).current;
  const [running, setRunning] = useState<string | null>(null);
  const runId = useRef<number | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const checkFailed = useRef(false);
  const ended = useRef<(() => void) | null>(null);   // resolves stop() when the run ends
  // The last run that ended, counted: a window can see a run ended even if
  // it was over before the window looked.
  const lastEnded = useRef<{ name: string; n: number }>({ name: "", n: 0 });
  const quitting = useRef(false);

  const pump = () => {
    if (quitting.current) return;
    const next = queue.next(optsRef.current.chatBusy());
    if (!next) return;
    const { name, slot } = next;
    queue.start(name);
    setRunning(name);
    optsRef.current.onStart?.(name);
    const s = bridge.stream("schedule.run", slot ? { name, slot } : { name }, {
      onEvent: (event: string, data: any) => optsRef.current.onEvent?.(name, event, data),
    });
    runId.current = s.id;
    s.done
      .finally(() => optsRef.current.onEnd?.(name))
      .then((d: any) => {
        if (d?.status === "ok") optsRef.current.addSystem(`Task ${name} finished — /schedule to see it.`);
        else if (d?.status === "cancelled") optsRef.current.addSystem(`Task ${name} cancelled.`);
      })
      .catch((e) =>
        optsRef.current.addSystem(`Task ${name} failed: ${(e as Error)?.message || e} — /schedule for details.`, true),
      )
      .finally(() => {
        runId.current = null;
        lastEnded.current = { name, n: lastEnded.current.n + 1 };
        queue.finish();
        setRunning(null);
        ended.current?.();
        ended.current = null;
        if (quitting.current) return;
        // A held chat message goes first. `chatBusy` can't see it yet (React
        // state lags), so don't pump now: the chat's end pumps again.
        if (!optsRef.current.onIdle()) pump();
      });
  };

  const enqueue = (name: string, slot?: string) => {
    if (queue.enqueue(name, slot)) pump();
  };

  const checkFailure = (e: unknown) => {
    // Said once per run of failures, not into the chat every 30 s.
    if (checkFailed.current) return;
    checkFailed.current = true;
    const msg = (e as Error)?.message || String(e);
    debugLog(`schedule.check failed: ${msg}`);
    optsRef.current.addSystem(`Scheduled tasks can't be checked: ${msg} — they won't run until this is fixed.`, true);
  };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      if (!stopped) timer = setTimeout(tick, schedulerTiming.checkMs);
    };
    const tick = () => {
      bridge
        .request("schedule.check", { startup: false })
        .then((d) => {
          checkFailed.current = false;
          for (const t of d?.due || []) enqueue(t.name, t.slot);
        })
        .catch(checkFailure)
        .finally(later);
    };
    const askMissed = async (missed: MissedTask[]) => {
      for (let i = 0; i < missed.length && !stopped; i++) {
        const m = missed[i]!;
        const choice = await optsRef.current.askMissed(m, i, missed.length);
        if (choice === "run") enqueue(m.name, m.slot);
        else bridge.request("schedule.skip", { name: m.name, slot: m.slot }).catch(checkFailure);
      }
    };
    bridge
      .request("schedule.check", { startup: true })
      .then(async (d) => {
        await askMissed(d?.missed || []);
        for (const t of d?.due || []) enqueue(t.name, t.slot);
      })
      .catch(checkFailure)
      .finally(later);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (runId.current != null) bridge.cancel(runId.current);
    };
  }, []);

  return {
    /** The task running now (for the footer and the Schedule window). */
    running,
    /** Live value for key handlers (React state lags fast input). */
    isRunning: () => queue.running,
    /** The last run that ended, and how many have (live). */
    lastEnded: () => lastEnded.current,
    runNow: (name: string) => enqueue(name),
    cancel: () => {
      if (runId.current != null) bridge.cancel(runId.current);
    },
    /** Try the queue again — after a chat turn ends. */
    pump,
    /** On quit: start nothing new, cancel the running task and resolve once
     *  the engine has recorded it (the caller bounds the wait). */
    stop: (): Promise<void> => {
      quitting.current = true;
      if (runId.current == null) return Promise.resolve();
      const done = new Promise<void>((r) => (ended.current = r));
      bridge.cancel(runId.current);
      return done;
    },
  };
}
