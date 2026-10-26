// Ported from AIhub-TUI v1.5.0 app/src/bridge/client.ts.
// aihub-code: only debugLog is used by hub code; it is the app's own (it
// writes to aihub-code's bridge error log). The client itself is the app's
// BridgeClient, reached through state/BridgeContext's adapter.
export { debugLog } from "../../bridge/client.ts";
