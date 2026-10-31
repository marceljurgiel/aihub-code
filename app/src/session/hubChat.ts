/**
 * An AIhub conversation: plain chat, or one of AIhub's agent profiles, run by
 * the engine's own turn driver (`chat.turn`) rather than the code agent.
 *
 * It holds what v1.5.0's ChatScreen keeps in its session for a chat: the
 * messages (the front-end owns them, the engine returns them after each
 * turn), the start time (the history file's name), and the turn's settings.
 * The controller draws the turn; this only builds the requests:
 *  - start(): `chat.start` (ChatScreen 273 / 682 / 729);
 *  - params(): the exact `chat.turn` params (ChatScreen 492–507);
 *  - finalize(): `chat.finalize` (ChatScreen 158, saveSession);
 *  - load(): a conversation from history (ChatScreen doLoadHistory).
 */
import { humanTokens } from "../hub/theme.ts";
import { toolsLabel } from "../hub/modals/AgentModal.tsx";
import type { Backend, Bridge } from "./controller";

export interface ChatMessage {
  role: string;
  content: string;
  images?: string[];
  [key: string]: unknown;
}

/** Who the conversation is with: plain chat or an AIhub agent profile. */
export type HubKind = { type: "chat" } | { type: "agent"; name: string; submode: "build" | "plan" };

export interface HubChatOptions {
  model: string;
  backend: Backend;
  /** The id the backend is asked for (an api:// url for API models). */
  streamModel?: string;
}

export class HubChat {
  messages: ChatMessage[] = [];
  /** ISO; the history file is named after it, so autosave updates one file. */
  startTime = new Date().toISOString();
  kind: HubKind = { type: "chat" };
  temperature = 0.7;
  contextLength = 0;
  toolsEnabled = true;
  /** Knowledge bases switched on for this chat (/kb). */
  knowledge: string[] = [];
  /** An interrupted turn changed the conversation since the last save (a
   *  finished turn is saved at once): quitting or going back to the code
   *  agent saves it, as AIhub's quit does. */
  unsaved = false;
  readonly model: string;
  readonly backend: Backend;
  readonly streamModel: string;

  constructor(
    private readonly bridge: Pick<Bridge, "request">,
    opts: HubChatOptions,
  ) {
    this.model = opts.model;
    this.backend = opts.backend;
    this.streamModel = opts.streamModel || opts.model;
  }

  /** A fresh conversation: the engine's opening messages (its system prompt). */
  async start(): Promise<void> {
    const r = await this.bridge.request<{ messages?: ChatMessage[] }>("chat.start", { model: this.model, messages: [] });
    this.messages = Array.isArray(r?.messages) ? r.messages : [];
  }

  /** The `chat.turn` params for the next message. The user's message joins
   *  the conversation now, as AIhub's `outgoing` does: a turn that fails
   *  keeps it, a finished one is replaced by the engine's copy (accept). */
  params(text: string, images: string[] = []): Record<string, unknown> {
    const user: ChatMessage = { role: "user", content: text };
    if (images.length) user.images = [...images];
    this.messages = [...this.messages, user];
    const agent = this.kind.type === "agent" ? this.kind : null;
    return {
      model: this.model,
      stream_model: this.streamModel,
      backend: this.backend,
      messages: this.messages,
      temperature: this.temperature,
      context_length: this.contextLength,
      tools_enabled: this.toolsEnabled,
      agent: agent !== null,
      agent_name: agent?.name ?? "",
      submode: agent?.submode ?? "build",
      knowledge: [...this.knowledge],
    };
  }

  /** The engine's messages after a turn (tool results, the reply). */
  accept(messages: unknown): void {
    if (Array.isArray(messages)) this.messages = messages as ChatMessage[];
  }

  /** Save to AIhub's history. `auto` honours the autosave setting. */
  finalize(auto: boolean): Promise<unknown> {
    this.unsaved = false;
    return this.bridge.request("chat.finalize", {
      model: this.model,
      messages: this.messages,
      temperature: this.temperature,
      start_time: this.startTime,
      backend: this.backend,
      stream_model: this.streamModel,
      auto,
    });
  }

  /** A saved conversation, keeping its own start time. */
  load(messages: ChatMessage[], startTime?: string): void {
    this.messages = [...messages];
    this.startTime = startTime || new Date().toISOString();
  }

  /** Something was said in it (worth saving). */
  hasUserMessages(): boolean {
    return this.messages.some((m) => m.role === "user");
  }
}

export interface AgentInfo {
  name: string;
  tools?: string[];
  permission?: string;
  model?: string;
}

/** AIhub's line on entering an agent (ChatScreen startAgent), with
 *  aihub-code's keys: /models for ^O, /agent for ^G. */
export function agentNote(
  agent: AgentInfo,
  submode: "build" | "plan",
  check: { context?: number; context_note?: string },
  model: string,
  currentContext: number,
): string {
  const asks = submode === "plan" || agent.permission === "ask";
  const ctx = Number(check.context) > 0 ? Number(check.context) : currentContext;
  return (
    `Agent ${agent.name} · ${submode} — ${humanTokens(ctx)} context` +
    `${check.context_note ? ` (${check.context_note})` : ""}. ` +
    `Tools: ${toolsLabel(agent.tools ?? []) || "none"}; ` +
    (asks ? "asks before edits and commands." : "runs edits and commands without asking.") +
    (agent.model && agent.model !== model ? `  This agent suggests ${agent.model} (/models).` : "") +
    "  /agent to switch."
  );
}
