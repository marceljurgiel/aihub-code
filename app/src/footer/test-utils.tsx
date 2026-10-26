/** Test helpers: a started controller on a mock bridge and a footer rendered over it. */
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import type { Args } from "../args";
import { memorySink } from "../scrollback";
import { commandTable } from "../commands";
import { Controller } from "../session/controller";
import { MockBridge } from "../session/mock-bridge";
import { AppKeymapProvider } from "../hub/keymap/AppKeymap";
import { adaptBridge, BridgeProvider } from "../hub/state/BridgeContext";
import { Footer } from "./Footer";
import type { SlashCommand } from "./SlashSuggest";

type ActFlag = { IS_REACT_ACT_ENVIRONMENT?: boolean };

export const INFO = {
  session_id: "s1",
  project: { root: "/home/alex/proj", branch: "main", dirty_total: 0, instruction_file: null, is_git: true },
  mode: "build",
  model: "m",
  rules: [],
  context_length: 1000,
  checkpoints: { mode: "shadow", note: "" },
};
export const ARGS: Args = { cont: false, mcp: [], kb: [] };

export const PERM = (id: number, extra: Record<string, unknown> = {}) => ({
  name: "edit_file",
  arguments: { path: "calc.py" },
  diff: null,
  suggested_rule: { tool: "edit_file", pattern: null, scope: "session" },
  mode: "build",
  reason: "edit",
  permission_id: id,
  ...extra,
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for a real timer's effect (a tick, a lapse) by polling, not by a
 *  fixed sleep that a loaded machine can outrun. Throws after `ms`. */
export async function until(pred: () => boolean | Promise<boolean>, step: () => Promise<void>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    await step();
    if (await pred()) return;
    if (Date.now() > end) throw new Error("until: timed out");
    await sleep(20);
  }
}

export interface Mounted {
  c: Controller;
  bridge: MockBridge;
  sink: ReturnType<typeof memorySink>;
  setup: Awaited<ReturnType<typeof testRender>>;
  heights: number[];
  exits: string[];
  submitted: string[];
  clock: { t: number };
  /** Let timers, bridge promises and React settle. */
  settle(): Promise<void>;
  /** The screen as text lines, trailing blank rows and spaces removed. */
  lines(): string[];
  frame(): string;
}

export interface MountOptions {
  width?: number;
  height?: number;
  commands?: SlashCommand[];
  history?: string[];
  guardMs?: number;
  /** Default: guardMs. */
  permissionQuietMs?: number;
  ctrlCWindowMs?: number;
  /** The most rows the footer may take (the app passes the terminal's budget). */
  maxHeight?: number;
  /** The terminal speaks the kitty keyboard protocol (default); false: legacy keys. */
  kitty?: boolean;
  /** Start the session (default); false leaves the controller as constructed. */
  start?: boolean | Partial<Args>;
  answers?: Record<string, unknown>;
  /** The terminal's rows, for the footer (a panel takes all but one). */
  rows?: number;
  /** Default: the providers app.tsx puts around the footer (AIhub's keymap and
   *  bridge), which an opened panel needs. */
  wrap?: (footer: ReactNode, bridge: MockBridge) => ReactNode;
}

export async function mount(o: MountOptions = {}): Promise<Mounted> {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = { default_chat_model: "m" };
  bridge.answers["code.start"] = INFO;
  bridge.answers["code.mode"] = (p: Record<string, unknown>) => ({ mode: p.mode });
  bridge.answers["models.installed"] = { models: [{ name: "m" }] };
  Object.assign(bridge.answers, o.answers ?? {});
  const sink = memorySink();
  const exits: string[] = [];
  const submitted: string[] = [];
  const clock = { t: 100_000 };
  const c = new Controller({
    bridge,
    sink,
    now: () => clock.t,
    width: () => o.width ?? 80,
    cwd: "/home/alex/proj",
    home: "/home/alex",
    commands: commandTable(),
    onExit: () => exits.push("exit"),
  });
  if (o.start !== false) await c.start({ ...ARGS, ...(typeof o.start === "object" ? o.start : {}) });
  const heights: number[] = [];
  const footer = (
    <Footer
      controller={c}
      width={o.width ?? 80}
      onHeight={(n) => heights.push(n)}
      onSubmit={(t) => {
        submitted.push(t);
        c.submit(t);
      }}
      commands={o.commands}
      history={o.history}
      now={() => clock.t}
      guardMs={o.guardMs ?? 0}
      permissionQuietMs={o.permissionQuietMs ?? o.guardMs ?? 0}
      ctrlCWindowMs={o.ctrlCWindowMs}
      maxHeight={o.maxHeight}
      rows={o.rows}
    />
  );
  const wrap =
    o.wrap ??
    ((f: ReactNode, b: MockBridge) => (
      <AppKeymapProvider>
        <BridgeProvider client={adaptBridge(b)}>{f}</BridgeProvider>
      </AppKeymapProvider>
    ));
  const setup = await testRender(wrap(footer, bridge), {
    width: o.width ?? 80,
    height: o.height ?? 30,
    kittyKeyboard: o.kitty ?? true,
    exitOnCtrlC: false, // as the real renderer: Ctrl+C is the footer's key
  });
  // The store changes from outside React (bridge answers, timers), not inside act().
  (globalThis as ActFlag).IS_REACT_ACT_ENVIRONMENT = false;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await sleep(10);
      await setup.flush();
      await setup.renderOnce();
    }
  };
  const frame = () =>
    setup
      .captureCharFrame()
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n+$/, "");
  await settle();
  return { c, bridge, sink, setup, heights, exits, submitted, clock, settle, frame, lines: () => frame().split("\n") };
}

export function unmount(m: Mounted | undefined): void {
  m?.setup.renderer.destroy();
}
