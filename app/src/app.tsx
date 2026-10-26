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
import { homedir } from "node:os";
import { useEffect, useState } from "react";
import type { Args } from "./args";
import { SLASH_COMMANDS, commandTable } from "./commands";
import { Footer } from "./footer/Footer";
import { debounced, exitLine, footerBudget, messagesToLines } from "./replay";
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

function FooterHost({ renderer, controller }: { renderer: CliRenderer; controller: Controller }) {
  const { width, rows } = useTerminal(renderer);
  return (
    <Footer
      controller={controller}
      width={width}
      maxHeight={footerBudget(rows)}
      // The renderer's footer follows the content at once (layout effect), so a
      // taller footer is never drawn for a frame in a shorter area.
      onHeight={(n) => {
        renderer.footerHeight = n;
      }}
      commands={SLASH_COMMANDS}
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
    onResume: (messages) => sink.write(messagesToLines(messages, renderer.width)),
    onExit: () => shutdown(),
  });

  function shutdown(): void {
    if (done) return;
    done = true;
    replay.cancel();
    const line = exitLine(controller.resumableSessionId());
    renderer.footerHeight = 1; // destroy leaves the footer's rows blank: keep that to one
    renderer.destroy(); // restores the terminal; the transcript stays in the scrollback
    bridge.destroy();
    o.onClosed?.(line);
    resolveClosed();
  }

  createRoot(renderer).render(<FooterHost renderer={renderer} controller={controller} />);
  void controller.start(o.args);
  return { controller, sink, transcript, closed, shutdown };
}
