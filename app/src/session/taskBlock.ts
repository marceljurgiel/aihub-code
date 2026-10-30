/**
 * A scheduled task's output in the transcript: a divider `task <name>`, then
 * what its run streams, drawn as an AIhub turn is (the controller's hub-turn
 * formatting): text as markdown, tool calls and their results, a round's text
 * when none was streamed, errors in red, the knowledge it draws on.
 *
 * The run is AIhub's own unattended turn (schedule.run): it never asks for a
 * permission, and its context and usage are not the conversation's, so those
 * events draw nothing.
 */
import type { Line } from "../scrollback";
import type { ToolCallEvent, ToolResultEvent } from "../transcript/events";
import { fmtDivider, fmtError, fmtToolCall, fmtToolResult } from "../transcript/format";
import { MarkdownStreamer } from "../transcript/markdown";
import { fmtKnowledge } from "./kinds";

export class TaskBlock {
  private readonly streamer: MarkdownStreamer;
  /** Text was streamed since the last round. */
  private streamed = false;

  constructor(
    readonly name: string,
    private readonly width: () => number,
    private readonly write: (lines: Line[]) => void,
  ) {
    this.write([[], ...fmtDivider(`task ${name}`, width())]);
    this.streamer = new MarkdownStreamer(width());
  }

  event(event: string, data: any): void {
    const width = this.width();
    switch (event) {
      case "text":
        this.streamed = true;
        this.write(this.streamer.feed(String(data?.text ?? "")));
        break;
      case "tool_call":
        this.flush();
        this.write(fmtToolCall(data as ToolCallEvent, width));
        break;
      case "tool_result": {
        this.flush();
        const ev = data as ToolResultEvent;
        // AIhub's turns send no code_diff: an edit's result is said as any other tool's.
        const rows = fmtToolResult(ev, width);
        this.write(rows.length ? rows : fmtToolResult({ ...ev, name: "" }, width));
        break;
      }
      case "round": {
        const text = String(data?.text ?? "");
        if (!this.streamed && text.trim()) this.write(this.streamer.feed(text));
        this.flush();
        this.streamed = false;
        break;
      }
      case "chat_error":
        this.flush();
        this.write(fmtError(String(data?.message ?? "error"), width));
        break;
      case "knowledge":
        this.flush();
        this.write(fmtKnowledge(data, width));
        break;
      // task (started), thinking, usage: nothing to show.
    }
  }

  /** The run is over: what is left of its text. */
  end(): void {
    this.flush();
  }

  private flush(): void {
    this.write(this.streamer.flush());
  }
}
