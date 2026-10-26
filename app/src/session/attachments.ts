/** The images waiting for the next turn (AIhub's pending attachments). */
import type { Attachment } from "../bridge/types";

/** AIhub takes at most eight images per message. */
export const MAX_IMAGES = 8;

export class Attachments {
  private items: Attachment[] = [];

  /** Adds an image; beyond the limit it is dropped. Returns whether it was kept. */
  add(a: Attachment): boolean {
    if (this.items.length >= MAX_IMAGES || this.items.some((x) => x.id === a.id)) return false;
    this.items.push(a);
    return true;
  }

  removeLast(): Attachment | undefined {
    return this.items.pop();
  }

  clear(): void {
    this.items = [];
  }

  list(): Attachment[] {
    return [...this.items];
  }

  ids(): string[] {
    return this.items.map((a) => a.id);
  }
}
