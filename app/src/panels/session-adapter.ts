/**
 * AIhub's windows read the chat session (`SessionState`, AIhub's
 * state/SessionContext) for the model, its context and the conversation's
 * kind. aihub-code's session is the controller's: this builds AIhub's shape
 * from it.
 *
 * What the controller doesn't track (messages, speed, the online flags) keeps
 * AIhub's defaults (initialSession). The memory and tools switches are the
 * controller's (Settings changes them); the knowledge bases are the
 * conversation's (`/kb`).
 * The kind maps onto AIhub's mode: plain chat is "chat", an AIhub agent is
 * "agent" with its name and submode, and the code agent is shown as an agent
 * named "code", its submode following plan / build (auto counts as build).
 */
import { initialSession, type SessionState } from "../hub/state/SessionContext.tsx";
import type { ControllerState } from "../session/controller";

export type SessionLike = SessionState;

function kindFields(s: ControllerState): Pick<SessionLike, "mode" | "agentName" | "agentSubmode"> {
  const k = s.kind;
  if (k.type === "chat") return { mode: "chat", agentName: "", agentSubmode: "build" };
  if (k.type === "agent") return { mode: "agent", agentName: k.name, agentSubmode: k.submode };
  return { mode: "agent", agentName: "code", agentSubmode: s.mode === "plan" ? "plan" : "build" };
}

export function toSessionLike(s: ControllerState): SessionLike {
  const ctx = s.ctx.limit > 0 ? s.ctx.limit : initialSession().contextLength;
  return {
    ...initialSession(),
    modelName: s.model || null,
    streamModel: s.streamModel || s.model,
    backend: s.backend,
    temperature: s.temperature,
    contextLength: ctx,
    ctxMax: ctx,
    ctxUsed: s.ctx.used,
    ...kindFields(s),
    knowledge: s.knowledge,
    memoryEnabled: s.memoryEnabled,
    toolsEnabled: s.toolsEnabled,
    streaming: s.phase === "running" || s.phase === "permission",
  };
}
