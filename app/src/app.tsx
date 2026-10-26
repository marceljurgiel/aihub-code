/**
 * Puts the pieces on a split-footer renderer: the controller writes the
 * transcript through a renderer sink, React draws only the footer, a resize
 * replays the transcript, a resumed session is written back into the
 * scrollback, and leaving restores the terminal before the resume line.
 *
 * `launch` takes the renderer and the bridge so tests can run it on a headless
 * renderer and a mock; index.tsx passes the real ones.
 */
import type { CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { constants, homedir } from "node:os";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Args } from "./args";
import { SLASH_COMMANDS, commandTable } from "./commands";
import { Footer } from "./footer/Footer";
import { clampFooterHeight, debounced, exitLine, footerBudget, messagesToLines, userPrompts } from "./replay";
import { Transcript, rendererSink, type RendererSink } from "./scrollback";
import { Controller, type Bridge } from "./session/controller";

/** The footer of an empty prompt: gap, box, status line. */
export const IDLE_FOOTER_ROWS = 5;
/** A resize settles this long before the transcript is written again. */
export const RESIZE_QUIET_MS = 120;

export interface AppBridge extends Bridge {
  /** Shut the bridge subprocess down. */
  destroy(): void;
}

export interface LaunchOptions {
  renderer: CliRenderer;
  bridge: AppBridge;
  args: Args;
  /** The project folder; the bridge runs there too. */
  cwd?: string;
  home?: string;
  /** Called once the terminal is restored and the bridge is gone, with the
   *  line to print (null: there is no session to resume). */
  onClosed?: (resumeLine: string | null) => void;
  /** How long a resize must be quiet before the replay. */
  resizeQuietMs?: number;
  /** Where the exit signals arrive (the process; tests pass an emitter). */
  proc?: { once(name: string, handler: () => void): unknown; off(name: string, handler: () => void): unknown };
  /** Ends the process if closing after a signal hangs (default: process.exit). */
  forceExit?: (code: number) => void;
  /** How long a signal's shutdown may take before forceExit (default: room
   *  for the turn's end and the bridge's cleanup, 1.5 s each). */
  forceExitMs?: number;
}

/** OpenTUI's own exit signals: its handler only destroys the renderer (and a
 *  handler being there drops the default "terminate"), so each one closes the
 *  app here, or a headless Bun would live on with its bridge. */
const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT", "SIGHUP", "SIGPIPE", "SIGBREAK", "SIGBUS"] as const;
const signalCode = (name: string): number => 128 + ((constants.signals as Record<string, number | undefined>)[name] ?? 0);

/** The prompts of a resumed session, for the footer's Up key. */
class HistoryStore {
  private items: readonly string[] = [];
  private subs = new Set<() => void>();
  get = (): readonly string[] => this.items;
  set(items: string[]): void {
    this.items = items;
    for (const f of [...this.subs]) f();
  }
  subscribe = (f: () => void): (() => void) => {
    this.subs.add(f);
    return () => this.subs.delete(f);
  };
}

export interface Launched {
  controller: Controller;
  sink: RendererSink;
  transcript: Transcript;
  /** Resolves when the app has been closed. */
  closed: Promise<void>;
  /** Close it (what /exit and Ctrl+C twice do). */
  shutdown(): void;
}

/** The terminal's size, following resizes. */
function useTerminal(renderer: CliRenderer): { width: number; rows: number } {
  const [size, setSize] = useState({ width: renderer.width, rows: renderer.terminalHeight });
  useEffect(() => {
    const onResize = () =>
      setSize((s) => (s.width === renderer.width && s.rows === renderer.terminalHeight ? s : { width: renderer.width, rows: renderer.terminalHeight }));
    renderer.on("resize", onResize);
    onResize();
    return () => {
      renderer.off("resize", onResize);
    };
  }, [renderer]);
  return size;
}

function FooterHost({ renderer, controller, history }: { renderer: CliRenderer; controller: Controller; history: HistoryStore }) {
  const { width, rows } = useTerminal(renderer);
  const prompts = useSyncExternalStore(history.subscribe, history.get);
  return (
    <Footer
      controller={controller}
      width={width}
      maxHeight={footerBudget(rows)}
      // The renderer's footer follows the content at once (layout effect), so a
      // taller footer is never drawn for a frame in a shorter area.
      onHeight={(n) => {
        renderer.footerHeight = clampFooterHeight(n, rows);
      }}
      commands={SLASH_COMMANDS}
      history={prompts}
    />
  );
}

export function launch(o: LaunchOptions): Launched {
  const { renderer, bridge } = o;
  const transcript = new Transcript();
  const sink = rendererSink(renderer, transcript);
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  let done = false;
  const prompts = new HistoryStore();

  // A resize leaves ghost footer rows behind: wait until it settles, clear,
  // and write the whole transcript again at the new width.
  const replay = debounced(() => {
    if (!done) sink.replay({ clearSavedLines: true });
  }, o.resizeQuietMs ?? RESIZE_QUIET_MS);
  // The renderer also says "resize" when only the footer's height changed (every
  // time the prompt grows a row): that is no reason to clear the screen.
  let terminal = { width: renderer.terminalWidth, rows: renderer.terminalHeight };
  renderer.on("resize", () => {
    const now = { width: renderer.terminalWidth, rows: renderer.terminalHeight };
    if (now.width === terminal.width && now.rows === terminal.rows) return;
    terminal = now;
    replay();
  });

  const controller: Controller = new Controller({
    bridge,
    sink,
    width: () => renderer.width,
    cwd: o.cwd,
    home: o.home ?? homedir(),
    commands: commandTable(),
    onResume: (messages) => {
      sink.write(messagesToLines(messages, renderer.width));
      prompts.set(userPrompts(messages));
    },
    onExit: () => shutdown(),
  });

  // A signal leaves as /exit does (a running turn is interrupted and its end
  // awaited, so the session is saved), and ends the process if that hangs.
  // The timer is unref'd, so it never keeps a process alive that is already done.
  const proc = o.proc ?? process;
  const handlers = EXIT_SIGNALS.map((name) => {
    const h = () => {
      const timer = setTimeout(() => (o.forceExit ?? ((c: number) => process.exit(c)))(signalCode(name)), o.forceExitMs ?? 4000);
      timer.unref?.();
      controller.exit();
    };
    proc.once(name, h);
    return [name, h] as const;
  });

  function shutdown(): void {
    if (done) return;
    done = true;
    replay.cancel();
    const line = exitLine(controller.resumableSessionId());
    for (const [name, h] of handlers) proc.off(name, h);
    try {
      // Core's own signal handler may have destroyed the renderer already.
      if (!renderer.isDestroyed) {
        renderer.footerHeight = 1; // destroy leaves the footer's rows blank: keep that to one
        renderer.destroy(); // restores the terminal; the transcript stays in the scrollback
      }
    } finally {
      try {
        bridge.destroy();
      } finally {
        o.onClosed?.(line);
        resolveClosed();
      }
    }
  }

  createRoot(renderer).render(<FooterHost renderer={renderer} controller={controller} history={prompts} />);
  void controller.start(o.args);
  return { controller, sink, transcript, closed, shutdown };
}
