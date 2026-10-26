import { expect, test } from "bun:test";
import type { Bridge } from "../../session/controller";
import { adaptBridge } from "./BridgeContext.tsx";

test("adaptBridge: requests pass through, streams hand events to onEvent, cancel is chat.cancel", async () => {
  const sent: unknown[] = [];
  let onEvent: (event: string, data: unknown) => void = () => {};
  const fake = {
    request: async (method: string, params: unknown) => ({ method, params }),
    stream: (_method: string, _params: unknown, cb: (event: string, data: unknown) => void) => {
      onEvent = cb;
      return { id: 7, done: Promise.resolve({ ok: true }) };
    },
    send: (msg: unknown) => sent.push(msg),
  } as unknown as Bridge;
  const hub = adaptBridge(fake);
  expect(await hub.request("kb.list")).toEqual({ method: "kb.list", params: {} });
  const events: unknown[] = [];
  const h = hub.stream("kb.add", { name: "home" }, { onEvent: (e, d) => events.push([e, d]) });
  onEvent("file", { i: 1 });
  expect(events).toEqual([["file", { i: 1 }]]);
  expect(h.id).toBe(7);
  expect(await h.done).toEqual({ ok: true });
  hub.cancel(7);
  expect(sent).toEqual([{ method: "chat.cancel", params: { request_id: 7 } }]);
});
