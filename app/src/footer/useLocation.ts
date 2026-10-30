/**
 * Where the model runs, for the status line: asked of the Ollama machine
 * (models.location, from its /api/ps) so it is right when Ollama runs on a
 * server. As AIhub's ChatScreen does it: every 10 s and at once after each
 * reply, paused while something streams (the model can't move mid-reply, and
 * the server is left to the one request it is serving); nothing while it isn't
 * known (offline, not an Ollama model).
 */
import { useEffect, useState } from "react";
import type { ModelLocation } from "../hub/state/SessionContext";
import type { Controller } from "../session/controller";
import { locationText } from "../session/status";
import { useController } from "../session/useController";

export const LOCATION_POLL_MS = 10_000;
const KNOWN = ["gpu", "split", "cpu", "unloaded", "cloud"];

export function useLocation(controller: Controller, everyMs: number = LOCATION_POLL_MS): string | null {
  const st = useController(controller);
  const model = st.backend === "ollama" ? st.streamModel || st.model : "";
  const busy = st.phase === "running" || st.phase === "permission" || st.taskRunning !== null;
  const [loc, setLoc] = useState<{ model: string; loc: ModelLocation } | null>(null);
  useEffect(() => {
    if (!model || busy) return;
    let alive = true;
    const ask = () =>
      controller.request("models.location", { model }).then(
        (d) => {
          if (alive) setLoc(KNOWN.includes(d?.state) ? { model, loc: d as ModelLocation } : null);
        },
        () => {}, // offline: say nothing
      );
    void ask();
    const t = setInterval(ask, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [controller, model, busy, everyMs]);
  // A new model: unknown until asked.
  return loc && loc.model === model ? locationText(loc.loc) : null;
}
