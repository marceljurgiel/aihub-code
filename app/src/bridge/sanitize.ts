/**
 * OpenTUI writes cell text to the terminal as-is, so a control character in
 * rendered text reaches the terminal raw: an ESC sequence from model output,
 * a file read by a tool or a web page could retitle the window, move the
 * cursor, hide or overwrite text, or (on some terminals) set the clipboard.
 *
 * Every string from the Python bridge passes through here. C0 controls become
 * their Unicode "control picture" (ESC → ␛), DEL → ␡ and C1 controls (8-bit
 * CSI/OSC) → U+FFFD. Newline and tab are kept.
 */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function sanitizeText(text: string): string {
  return text.replace(CONTROL, (c) => {
    const code = c.charCodeAt(0);
    if (code < 0x20) return String.fromCharCode(0x2400 + code);
    if (code === 0x7f) return "␡";
    return "�";
  });
}

/** JSON.parse reviver applying sanitizeText to every string value. */
export function sanitizingReviver(_key: string, value: unknown): unknown {
  return typeof value === "string" ? sanitizeText(value) : value;
}
