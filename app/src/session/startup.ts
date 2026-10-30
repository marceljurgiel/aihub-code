/**
 * Start-up checks that run once in the background, after the session is up.
 */

export interface OllamaUpdate {
  newer?: boolean;
  latest?: string;
  server?: string;
  host?: string;
  command?: string;
  how?: "manual" | "app" | "local" | string;
}

/** What to say about a newer Ollama, or null for nothing. The `manual` and
 *  `app` texts are AIhub's (ChatScreen checkOllamaUpdate). There is no
 *  terminal panel here to run the update, so for this machine the command is
 *  printed to run oneself. */
export function ollamaUpdateNote(d: OllamaUpdate | null | undefined): string | null {
  if (!d?.newer) return null;
  const out = `Ollama ${d.latest} is out`;
  if (d.how === "manual") return `${out} — ${d.host} has ${d.server}, and newer models need it. Update it on that machine: ${d.command}`;
  if (d.how === "app") return `${out} — this machine has ${d.server}. The Ollama app updates itself: open it, or get it at ollama.com/download.`;
  return `${out} — this machine has ${d.server}. Update it: ${d.command}`;
}

/** Is there a newer Ollama than the one the engine talks to? Said as one
 *  note; a failed check says nothing (it is a courtesy, and offline is normal). */
export async function checkOllamaUpdate(request: (method: string) => Promise<OllamaUpdate>, note: (text: string) => void): Promise<void> {
  try {
    const text = ollamaUpdateNote(await request("ollama.update_check"));
    if (text) note(text);
  } catch {
    // background check
  }
}
