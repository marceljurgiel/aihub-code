import { describe, expect, test } from "bun:test";
import { Attachments, MAX_IMAGES } from "./attachments";

const img = (id: string) => ({ id, name: `${id}.png`, width: 1, height: 1, kb: 1 });

describe("Attachments", () => {
  test("add, list, ids, removeLast, clear", () => {
    const a = new Attachments();
    a.add(img("a1"));
    a.add(img("a2"));
    expect(a.ids()).toEqual(["a1", "a2"]);
    expect(a.removeLast()?.id).toBe("a2");
    expect(a.list().map((x) => x.id)).toEqual(["a1"]);
    a.clear();
    expect(a.list()).toEqual([]);
  });
  test("list is a copy", () => {
    const a = new Attachments();
    a.add(img("a1"));
    a.list().pop();
    expect(a.list()).toHaveLength(1);
  });
  test("the same id twice is kept once; the ninth image is refused", () => {
    const a = new Attachments();
    expect(a.add(img("a1"))).toBe(true);
    expect(a.add(img("a1"))).toBe(false);
    for (let i = 2; i <= MAX_IMAGES + 1; i++) a.add(img(`a${i}`));
    expect(a.list()).toHaveLength(MAX_IMAGES);
  });
});
