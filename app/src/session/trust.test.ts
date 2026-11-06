import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileTrust } from "./trust";

function store(initial?: string) {
  const dir = mkdtempSync(join(tmpdir(), "trust-"));
  const path = join(dir, "aihub-code-settings.json");
  if (initial !== undefined) writeFileSync(path, initial);
  return { path, trust: fileTrust(path, "/home/alex") };
}

describe("trusted folders (aihub-code-settings.json)", () => {
  test("nothing is trusted until the user says so; then the folder and what is under it", () => {
    const { trust } = store();
    expect(trust.trusted("/home/alex/proj")).toBe(false);
    trust.trust("/home/alex/proj");
    expect(trust.trusted("/home/alex/proj")).toBe(true);
    expect(trust.trusted("/home/alex/proj/src/lib")).toBe(true);
    expect(trust.trusted("/home/alex/project-two")).toBe(false); // a prefix is not a parent
    expect(trust.trusted("/home/alex")).toBe(false);
  });

  test("trusting the home folder or the root covers only that folder", () => {
    const { trust } = store();
    trust.trust("/home/alex");
    trust.trust("/");
    expect(trust.trusted("/home/alex")).toBe(true);
    expect(trust.trusted("/")).toBe(true);
    expect(trust.trusted("/home/alex/proj")).toBe(false);
    expect(trust.trusted("/srv/app")).toBe(false);
  });

  test("the other settings stay, and a folder is saved once", () => {
    const { path, trust } = store(JSON.stringify({ theme: "nord", accent: "teal" }));
    trust.trust("/home/alex/proj/");
    trust.trust("/home/alex/proj");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc).toEqual({ theme: "nord", accent: "teal", trusted: [resolve("/home/alex/proj")] });
  });

  test("a broken file trusts nothing, and trusting starts it over", () => {
    const { path, trust } = store("{ not json");
    expect(trust.trusted("/home/alex/proj")).toBe(false);
    trust.trust("/home/alex/proj");
    expect(JSON.parse(readFileSync(path, "utf8")).trusted).toEqual([resolve("/home/alex/proj")]);
  });

  test("odd entries in the list are ignored", () => {
    const { trust } = store(JSON.stringify({ trusted: [7, null, "", "relative/dir", "/home/alex/ok"] }));
    expect(trust.trusted("/home/alex/ok/x")).toBe(true);
    expect(trust.trusted("/home/alex/relative/dir")).toBe(false);
  });
});
