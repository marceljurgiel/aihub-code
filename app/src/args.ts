/** What `aihub-code` passes to the app: the CLI flags, as JSON in AIHUB_CODE_ARGS
 *  (set by aihub_code/cli.py). Anything malformed is dropped, never fatal. */
export type Mode = "plan" | "build" | "auto";

export interface Args {
  model?: string;
  mode?: Mode;
  /** `--resume ID` (a session id) or `--resume` alone (true: pick from a list). */
  resume?: string | true;
  /** `--continue`: resume the newest session of this folder. */
  cont: boolean;
  mcp: string[];
  kb: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseArgs(env: Record<string, string | undefined> = process.env): Args {
  const out: Args = { cont: false, mcp: [], kb: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(env.AIHUB_CODE_ARGS ?? "");
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.model === "string" && r.model) out.model = r.model;
  if (r.mode === "plan" || r.mode === "build" || r.mode === "auto") out.mode = r.mode;
  if (r.resume === true || (typeof r.resume === "string" && r.resume)) out.resume = r.resume as string | true;
  if (r.cont === true) out.cont = true;
  out.mcp = strings(r.mcp);
  out.kb = strings(r.kb);
  return out;
}
