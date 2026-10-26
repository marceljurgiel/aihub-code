// Ported from AIhub-TUI v1.5.0 app/src/state/BridgeContext.tsx.
/** @jsxImportSource ../jsx */
import { createContext, useContext, type ReactNode } from "react";
import type { StreamHandlers } from "../bridge/types.ts";
import type { Bridge } from "../../session/controller";

/**
 * aihub-code: what AIhub's windows use of its BridgeClient — `request`,
 * `stream(method, params, {onEvent})` → `{id, done}` and `cancel(id)` — so the
 * ported windows run unmodified. `adaptBridge` builds it over aihub-code's own
 * bridge (the controller's `Bridge`): a stream's events go to `onEvent`, and
 * `cancel` sends the same `chat.cancel {request_id}` control AIhub's client
 * sends, which the bridge routes to the delegated AIhub stream (Task 1).
 */
export interface HubBridge {
  request<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  stream(method: string, params: Record<string, unknown>, handlers: StreamHandlers): { id: number; done: Promise<any> };
  cancel(requestId: number): void;
}

export function adaptBridge(b: Bridge): HubBridge {
  return {
    request: (method, params = {}) => b.request(method, params),
    stream: (method, params, handlers) => {
      const h = b.stream(method, params, (event, data) => handlers.onEvent?.(event, data));
      return { id: h.id, done: h.done };
    },
    cancel: (requestId) => b.send({ method: "chat.cancel", params: { request_id: requestId } }),
  };
}

const BridgeContext = createContext<HubBridge | null>(null);

export function BridgeProvider({
  client,
  children,
}: {
  client: HubBridge;
  children: ReactNode;
}) {
  return <BridgeContext.Provider value={client}>{children}</BridgeContext.Provider>;
}

export function useBridge(): HubBridge {
  const c = useContext(BridgeContext);
  if (!c) throw new Error("useBridge must be used within a BridgeProvider");
  return c;
}
