/**
 * Folders the user trusts aihub-code in, asked once per folder at start-up
 * (as Claude Code does): the code agent reads, edits and runs files there and
 * follows the project's instruction file. Kept in aihub-code's own settings,
 * ~/.aihub/aihub-code-settings.json, as `trusted: [absolute paths]`.
 *
 * A trusted folder covers the folders under it, except the home folder and a
 * drive's root: trusting those trusts only themselves, never everything below.
 */
import { isAbsolute, parse, resolve, sep } from "node:path";
import { homeDir } from "../home";
import { codeSettingsPath, readCodeSettings, updateCodeSettings } from "../theme";

export interface TrustStore {
  trusted(dir: string): boolean;
  /** Remember the folder; throws when it can't be saved. */
  trust(dir: string): void;
}

const windows = process.platform === "win32";
const norm = (p: string): string => {
  const r = resolve(p);
  return windows ? r.toLowerCase() : r;
};

function entries(path: string): string[] {
  const list = readCodeSettings(path).trusted;
  return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string" && e !== "" && isAbsolute(e)) : [];
}

export function fileTrust(path: string = codeSettingsPath(), home: string = homeDir()): TrustStore {
  const homeKey = norm(home);
  return {
    trusted(dir) {
      const d = norm(dir);
      return entries(path).some((e) => {
        const t = norm(e);
        if (d === t) return true;
        if (t === homeKey || t === parse(t).root) return false;
        return d.startsWith(t.endsWith(sep) ? t : t + sep);
      });
    },
    trust(dir) {
      const d = resolve(dir);
      updateCodeSettings((doc) => {
        const list = entries(path);
        if (!list.some((e) => norm(e) === norm(d))) list.push(d);
        doc.trusted = list;
      }, path);
    },
  };
}
