import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";

const HUB = join(import.meta.dir, "..");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsxFiles(join(dir, e.name))
      : e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx") // tests run from app/ only
        ? [join(dir, e.name)]
        : [],
  );
}

describe("console-safe JSX in AIhub's windows (Windows)", () => {
  test("every hub .tsx names the hub's JSX runtime itself", () => {
    // Bun takes jsxImportSource from the tsconfig of the directory it starts
    // in, and aihub-code starts in the user's project: a per-file pragma is the
    // only way the console-safe runtime reaches every window.
    for (const f of tsxFiles(HUB)) {
      const want = relative(dirname(f), join(HUB, "jsx")).replaceAll("\\", "/");
      const pragma = `/** @jsxImportSource ${want.startsWith(".") ? want : "./" + want} */`;
      expect(readFileSync(f, "utf8").split("\n").slice(0, 3), relative(HUB, f)).toContain(pragma);
    }
  });

  test("a window drawn from another directory swaps the glyphs Consolas lacks", () => {
    const run = (glyphs: string) =>
      Bun.spawnSync([process.execPath, join(HUB, "jsx", "safe-probe.ts")], {
        cwd: tmpdir(),
        env: { ...process.env, AIHUB_GLYPHS: glyphs },
      }).stdout.toString();
    const safe = run("ascii-safe");
    expect(safe).toContain("♦ Probe");
    expect(safe).toContain(" enter ");
    expect(safe).not.toContain("◆");
    expect(run("unicode")).toContain("◆ Probe");
  });
});
