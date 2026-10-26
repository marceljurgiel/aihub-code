import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { memorySink } from "../scrollback";
import { Controller } from "./controller";
import { MockBridge } from "./mock-bridge";
import { useController } from "./useController";

type ActFlag = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actFlag = (globalThis as ActFlag).IS_REACT_ACT_ENVIRONMENT;
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  (globalThis as ActFlag).IS_REACT_ACT_ENVIRONMENT = actFlag;
  setup?.renderer.destroy();
  setup = undefined;
});

function Probe({ controller }: { controller: Controller }) {
  const s = useController(controller);
  return <text>{`phase=${s.phase} mode=${s.mode} queue=${s.queue.length}`}</text>;
}

test("the hook re-renders when the controller's state changes", async () => {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = { default_chat_model: "m" };
  bridge.answers["code.start"] = { session_id: "s", project: { root: "/p" }, mode: "build", model: "m", context_length: 1000, checkpoints: {} };
  bridge.answers["code.mode"] = (p: Record<string, unknown>) => ({ mode: p.mode });
  const c = new Controller({ bridge, sink: memorySink(), width: () => 80, cwd: "/p" });
  setup = await testRender(<Probe controller={c} />, { width: 40, height: 3 });
  // The store changes from outside React (bridge answers), not inside act().
  (globalThis as ActFlag).IS_REACT_ACT_ENVIRONMENT = false;
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("phase=starting");
  await c.start({ cont: false, mcp: [], kb: [] });
  c.setMode("plan");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("phase=idle mode=plan queue=0");
});
