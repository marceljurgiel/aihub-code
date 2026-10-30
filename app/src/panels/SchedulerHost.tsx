/** @jsxImportSource ../hub/jsx */
/**
 * AIhub's clock for scheduled tasks (hub/schedule/useScheduler.ts) while
 * aihub-code is open. It renders nothing; the controller gates it:
 *  - a task starts only when the controller isn't busy (a turn, a /skill about
 *    to send one, memory learning): one model request at a time;
 *  - the task's events go to the controller, which prints them as a block;
 *  - a prompt typed during a task waits in the queue and goes when it ends
 *    (`onIdle`), before the next task;
 *  - missed slots are asked about in the `missed` panel;
 *  - the controller holds the clock's handle: the Schedule window, `/schedule
 *    run` and exit (which cancels a running task) use it.
 *
 * AIhub pumps the queue when the chat stops streaming; here, whenever the
 * controller's state changes and it is free — after the change's own work
 * (a turn's end drains the prompt queue first), so a microtask later.
 */
import { useEffect, useRef } from "react";
import { useScheduler } from "../hub/schedule/useScheduler";
import type { Controller } from "../session/controller";

export function SchedulerHost({ controller: c }: { controller: Controller }) {
  const s = useScheduler({
    chatBusy: () => c.isBusy(),
    addSystem: (text, error) => c.taskNote(text, error),
    onIdle: () => c.taskIdle(),
    askMissed: (task, index, total) => c.askMissed(task, index, total),
    onStart: (name) => c.taskStarted(name),
    onEvent: (_name, event, data) => c.taskEvent(event, data),
    onEnd: () => c.taskEnded(),
  });
  const latest = useRef(s);
  latest.current = s;

  useEffect(() => {
    const detach = c.attachScheduler({
      runNow: (name) => latest.current.runNow(name),
      cancel: () => latest.current.cancel(),
      isRunning: () => latest.current.isRunning(),
      lastEnded: () => latest.current.lastEnded(),
      stop: () => latest.current.stop(),
    });
    let live = true;
    const unsub = c.subscribe(() =>
      queueMicrotask(() => {
        if (live && !c.isBusy()) latest.current.pump();
      }),
    );
    return () => {
      live = false;
      unsub();
      detach();
    };
  }, [c]);

  return null;
}
