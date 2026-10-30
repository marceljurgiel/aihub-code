import { describe, expect, test } from "bun:test";
import { checkOllamaUpdate, ollamaUpdateNote, type OllamaUpdate } from "./startup";

const base: OllamaUpdate = { newer: true, latest: "0.40.2", server: "0.30.7", host: "gpu-box", command: "curl -fsSL https://ollama.com/install.sh | sh" };

describe("the Ollama update check", () => {
  test("a server somewhere else: whose Ollama it is and the command to run on that machine", () => {
    expect(ollamaUpdateNote({ ...base, how: "manual" })).toBe(
      "Ollama 0.40.2 is out — gpu-box has 0.30.7, and newer models need it. Update it on that machine: curl -fsSL https://ollama.com/install.sh | sh",
    );
  });
  test("the Ollama app updates itself", () => {
    expect(ollamaUpdateNote({ ...base, how: "app" })).toBe(
      "Ollama 0.40.2 is out — this machine has 0.30.7. The Ollama app updates itself: open it, or get it at ollama.com/download.",
    );
  });
  test("this machine: no terminal panel to run it in, so the command is printed", () => {
    expect(ollamaUpdateNote({ ...base, how: "local" })).toBe(
      "Ollama 0.40.2 is out — this machine has 0.30.7. Update it: curl -fsSL https://ollama.com/install.sh | sh",
    );
  });
  test("nothing newer, or no answer: nothing to say", () => {
    expect(ollamaUpdateNote({ ...base, newer: false, how: "local" })).toBeNull();
    expect(ollamaUpdateNote({})).toBeNull();
    expect(ollamaUpdateNote(null)).toBeNull();
  });

  test("checkOllamaUpdate prints one note for each how, and none when the check fails", async () => {
    for (const how of ["manual", "app", "local"]) {
      const notes: string[] = [];
      await checkOllamaUpdate(async (m) => (m === "ollama.update_check" ? { ...base, how } : {}), (t) => notes.push(t));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("Ollama 0.40.2 is out");
    }
    const notes: string[] = [];
    await checkOllamaUpdate(() => Promise.reject(new Error("offline")), (t) => notes.push(t));
    expect(notes).toEqual([]);
  });
});
