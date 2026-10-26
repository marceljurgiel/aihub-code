/**
 * AIhub's windows read the chat session (`SessionState`, AIhub's
 * state/SessionContext) for the model, its context and the conversation's
 * kind. aihub-code's session is the controller's: this builds AIhub's shape
 * from it.
 *
 * Fields the controller doesn't track yet get AIhub's defaults (initialSession):
 *  - backend "ollama", streamModel = the model (Task 4 adds the backend);
 *  - temperature 0.7 (Task 4 adds setTemperature and the saved value);
 *  - memoryEnabled / toolsEnabled true (Task 10, from config);
 *  - knowledge [] (Task 7).
 * The code agent is shown as AIhub's agent mode named "code", its submode
 * following plan / build (auto counts as build); Task 5 adds the other kinds.
 */
import { initialSession, type SessionState } from "../hub/state/SessionContext.tsx";
import type { ControllerState } from "../session/controller";

export type SessionLike = SessionState;

export function toSessionLike(s: ControllerState): SessionLike {
  const ctx = s.ctx.limit > 0 ? s.ctx.limit : initialSession().contextLength;
  return {
    ...initialSession(),
    modelName: s.model || null,
    streamModel: s.model,
    backend: "ollama",
    contextLength: ctx,
    ctxMax: ctx,
    ctxUsed: s.ctx.used,
    mode: "agent",
    agentName: "code",
    agentSubmode: s.mode === "plan" ? "plan" : "build",
    streaming: s.phase === "running" || s.phase === "permission",
  };
}
