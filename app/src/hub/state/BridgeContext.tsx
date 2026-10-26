// Ported from AIhub-TUI v1.5.0 app/src/state/BridgeContext.tsx.
import { createContext, useContext, type ReactNode } from "react";
import type { Bridge } from "../../session/controller";

// aihub-code: the controller's `Bridge` (what it needs of BridgeClient), so the
// app's BridgeClient and the tests' MockBridge both fit.
export type HubBridge = Bridge;

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
