import { expect, test } from "bun:test";
import { parseArgs } from "./args.ts";

test("empty env gives the defaults", () => {
  expect(parseArgs({})).toEqual({ cont: false, mcp: [], kb: [] });
});

test("full JSON is read", () => {
  const env = {
    AIHUB_CODE_ARGS: JSON.stringify({ model: "m:cloud", mode: "auto", resume: "abc", cont: true, mcp: ["git"], kb: ["docs", "api"] }),
  };
  expect(parseArgs(env)).toEqual({ model: "m:cloud", mode: "auto", resume: "abc", cont: true, mcp: ["git"], kb: ["docs", "api"] });
});

test("--resume without an id is true", () => {
  expect(parseArgs({ AIHUB_CODE_ARGS: '{"resume":true}' }).resume).toBe(true);
});

test("bad JSON gives the defaults", () => {
  expect(parseArgs({ AIHUB_CODE_ARGS: "{nope" })).toEqual({ cont: false, mcp: [], kb: [] });
  expect(parseArgs({ AIHUB_CODE_ARGS: "[1]" })).toEqual({ cont: false, mcp: [], kb: [] });
});

test("unknown mode and wrongly typed fields are dropped", () => {
  const out = parseArgs({ AIHUB_CODE_ARGS: JSON.stringify({ mode: "yolo", model: 5, mcp: "git", kb: ["a", 3], cont: "yes" }) });
  expect(out).toEqual({ cont: false, mcp: [], kb: ["a"] });
});
