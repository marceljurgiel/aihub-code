import { describe, expect, test } from "bun:test";
import { MAX_TIP, pickTip, TIP_PREFIX, TIPS } from "./tips";

describe("Did you know? tips", () => {
  test("each is one short sentence, none twice", () => {
    for (const t of TIPS) {
      expect(t.text.length).toBeLessThanOrEqual(MAX_TIP);
      expect(t.text).toMatch(/^\S.*[.!]$/);
      expect(t.text.slice(0, -1)).not.toMatch(/[.!?]\s/); // no second sentence
    }
    expect(new Set(TIPS.map((t) => t.text)).size).toBe(TIPS.length);
  });

  test("about AIhub's features and about agentic AI", () => {
    expect(TIPS.filter((t) => t.about === "aihub").length).toBeGreaterThanOrEqual(10);
    expect(TIPS.filter((t) => t.about === "agents").length).toBeGreaterThanOrEqual(10);
  });

  test("a random tip that fits the terminal, or none", () => {
    expect(pickTip(80, () => 0)).toBe(TIPS[0]!.text);
    const last = pickTip(200, () => 0.9999);
    expect(last).toBe(TIPS.at(-1)!.text);
    for (const r of [0, 0.3, 0.7, 0.99]) {
      const t = pickTip(66, () => r)!;
      expect(1 + TIP_PREFIX.length + t.length).toBeLessThanOrEqual(66);
    }
    expect(pickTip(20, () => 0.5)).toBeNull();
  });
});
