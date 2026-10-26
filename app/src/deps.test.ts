import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// OpenTUI's packages must resolve to one version: keymap 0.5.17 pulls core
// 0.5.17 while core is overridden to 0.5.6, which breaks once keymap is imported.
test("bun.lock resolves every @opentui package to 0.5.6", () => {
  const lock = readFileSync(join(import.meta.dir, "..", "bun.lock"), "utf8");
  const resolved = [...lock.matchAll(/"(@opentui\/[a-z-]+)@(\d+\.\d+\.\d+)"/g)].map((m) => `${m[1]}@${m[2]}`);
  expect(resolved.length).toBeGreaterThan(2);
  for (const r of resolved) expect(r.endsWith("@0.5.6")).toBe(true);
});
