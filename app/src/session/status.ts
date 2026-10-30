/**
 * What the status line says, as plain strings in the order they give way
 * (the last goes first when the line is too narrow):
 *   1. `model · location`   (where it runs: AIhub's wording, from models.location)
 *   2. the kind and mode    (`build`, `chat`, `agent <name> · plan`)
 *   3. `ctx N%`
 *   4. `kb:<n>` and `mcp:on` (what the conversation draws on)
 *   5. `task <name>…`       (the scheduled task running now)
 */
import type { ModelLocation } from "../hub/state/SessionContext";
import { displayWidth, sanitize, truncate } from "../width";
import type { ControllerState } from "./controller";
import { kindLabel } from "./kinds";

export const STATUS_SEP = " · ";

/** AIhub's wording (its header): nothing while the location isn't known, so
 *  the line never guesses. */
export function locationText(loc: ModelLocation | null | undefined): string | null {
  if (!loc) return null;
  switch (loc.state) {
    case "gpu":
      return `GPU 100% ${loc.vram_gb.toFixed(1)}G`;
    case "split": {
      const gpu = Math.round(loc.gpu_fraction * 100);
      return `GPU ${gpu}% · CPU ${100 - gpu}%`;
    }
    case "cpu":
      return "CPU";
    case "unloaded":
      return "not loaded";
    case "cloud":
      return "cloud";
  }
}

type StatusState = Pick<ControllerState, "kind" | "mode" | "model" | "ctx" | "knowledge" | "mcp" | "taskRunning">;

/** Every item there is, in priority order. */
export function allStatusItems(s: StatusState, location: string | null): string[] {
  const model = sanitize(s.model) || "no model";
  const items = [location ? `${model}${STATUS_SEP}${location}` : model, kindLabel(s.kind, s.mode)];
  if (s.ctx.limit > 0) items.push(`ctx ${Math.min(100, Math.round((s.ctx.used / s.ctx.limit) * 100))}%`);
  const uses = [s.knowledge.length ? `kb:${s.knowledge.length}` : "", s.mcp ? "mcp:on" : ""].filter(Boolean).join(" ");
  if (uses) items.push(uses);
  if (s.taskRunning) items.push(`task ${sanitize(s.taskRunning)}…`);
  return items;
}

/** The columns a line of these items takes: a leading space, the separators. */
export const itemsWidth = (items: readonly string[]): number =>
  1 + items.reduce((w, it, i) => w + (i ? STATUS_SEP.length : 0) + displayWidth(it), 0);

/** Items dropped from the end until the line fits `width`; when even the
 *  first doesn't, it is cut. */
export function fitItems(items: readonly string[], width: number): string[] {
  for (let n = items.length; n >= 1; n--) {
    const part = items.slice(0, n);
    if (itemsWidth(part) <= width) return part;
  }
  return items.length ? [truncate(items[0]!, Math.max(1, width - 1))] : [];
}

/** The items of the status line that fit `width`. */
export function statusItems(s: StatusState, location: string | null, width: number): string[] {
  return fitItems(allStatusItems(s, location), width);
}
