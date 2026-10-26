// Ported from AIhub-TUI v1.5.0 app/src/clipboard.ts.
/**
 * System clipboard → focused text field, for Ctrl+V.
 *
 * In a terminal, Ctrl+V is not paste: it sends a control byte, and the
 * terminal's own paste is Ctrl+Shift+V (delivered as a bracketed paste, which
 * OpenTUI's input/textarea already handle). People press Ctrl+V anyway, so we
 * read the clipboard ourselves and feed it through the same `handlePaste` path
 * a terminal paste takes — each field keeps its own paste rules (single-line
 * inputs drop newlines, the chat box keeps them).
 */
import { PasteEvent, decodePasteBytes, stripAnsiSequences, type EditBufferRenderable } from "@opentui/core";

type Reader = { cmd: string[]; when: () => boolean };

const READERS: Reader[] = [
  { cmd: ["wl-paste", "--no-newline"], when: () => !!process.env.WAYLAND_DISPLAY },
  { cmd: ["xclip", "-selection", "clipboard", "-o"], when: () => !!process.env.DISPLAY },
  { cmd: ["xsel", "--clipboard", "--output"], when: () => !!process.env.DISPLAY },
  { cmd: ["pbpaste"], when: () => process.platform === "darwin" },
  { cmd: ["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"], when: () => process.platform === "win32" },
];

/** Clipboard text, or throws with a reason when no clipboard tool works. */
export async function readClipboard(): Promise<string> {
  const tried: string[] = [];
  for (const r of READERS) {
    if (!r.when() || !Bun.which(r.cmd[0]!)) continue;
    tried.push(r.cmd[0]!);
    try {
      const proc = Bun.spawn(r.cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const timer = setTimeout(() => proc.kill(), 2000);
      const out = await new Response(proc.stdout).text();
      clearTimeout(timer);
      if ((await proc.exited) === 0) return out;
    } catch {
      /* try the next tool */
    }
  }
  throw new Error(
    tried.length
      ? `clipboard read failed (${tried.join(", ")})`
      : "no clipboard tool found — install wl-clipboard (Wayland) or xclip (X11)",
  );
}

/** Does the clipboard hold an image (a screenshot, a copied picture)? */
export async function clipboardHasImage(): Promise<boolean> {
  const probes: string[][] = [];
  if (process.platform === "win32")
    probes.push([
      "powershell", "-NoProfile", "-STA", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { 'image/png' }",
    ]);
  if (process.env.WAYLAND_DISPLAY && Bun.which("wl-paste")) probes.push(["wl-paste", "--list-types"]);
  if (process.env.DISPLAY && Bun.which("xclip")) probes.push(["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"]);
  for (const cmd of probes) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const timer = setTimeout(() => proc.kill(), 2000);
      const out = await new Response(proc.stdout).text();
      clearTimeout(timer);
      if ((await proc.exited) === 0 && /(^|\s)image\//.test(out)) return true;
    } catch {
      /* next tool */
    }
  }
  return false;
}

/** Ctrl+V with an image in the clipboard: whoever can take it (the chat
 *  screen, while the prompt has focus) registers here and returns true. */
export const imagePaste: { handler: (() => boolean) | null } = { handler: null };

/** Pasted text that is only image file paths — a file dropped on the
 *  terminal, or copied paths (quoted, file://, ~). */
export function looksLikeImagePaths(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 4000) return false;
  const parts = t.match(/'[^']+'|"[^"]+"|(?:\\ |\S)+/g) ?? [];
  // POSIX (/, ~, ./), file:// URIs and Windows (C:\…) paths.
  return (
    parts.length > 0 &&
    parts.every((p) =>
      /^['"]?(?:file:\/\/|~|\/|\.{1,2}[\/\\]|[A-Za-z]:[\\/])[^'"]*\.(png|jpe?g|webp|gif|bmp|tiff?|heic)['"]?$/i.test(p),
    )
  );
}

type Pasteable = {
  handlePaste?(event: PasteEvent): void;
  /** What a focused renderable registers for terminal pastes: runs its
   *  `onPaste` hook, then `handlePaste` unless the hook prevented it. */
  pasteHandler?: ((event: PasteEvent) => void) | null;
};

/**
 * Paste `text` into `target` exactly like a terminal paste would. Returns
 * false when the target can't take a paste (nothing focused, not a field).
 */
export function pasteInto(target: unknown, text: string): boolean {
  const t = target as Pasteable | null;
  const dispatch = t?.pasteHandler ?? (t?.handlePaste ? (e: PasteEvent) => t.handlePaste!(e) : null);
  if (!dispatch || !text) return false;
  // Same hygiene as terminal pastes: no escape sequences into our fields.
  dispatch(new PasteEvent(new TextEncoder().encode(stripAnsiSequences(text))));
  return true;
}

/**
 * `onPaste` for single-line inputs. OpenTUI's input drops newlines from a
 * paste, so "line one\nline two" became "line oneline two"; here each line
 * break becomes a space instead. Covers both Ctrl+V and terminal pastes.
 */
export function singleLinePaste(this: EditBufferRenderable, event: PasteEvent) {
  event.preventDefault();
  const text = stripAnsiSequences(decodePasteBytes(event.bytes))
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\t/g, " ");
  if (text) this.insertText(text);
}
