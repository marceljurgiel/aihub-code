/**
 * "Did you know?" — one short sentence above the prompt when aihub-code
 * starts: something AIhub can do, or something about agentic AI. One is
 * picked at random each start, among those that fit the terminal.
 */

export const TIP_PREFIX = "Did you know? ";
/** The longest tip: it fits an 80-column terminal on one row with the prefix. */
export const MAX_TIP = 64;

export interface Tip {
  text: string;
  about: "aihub" | "agents";
}

const aihub = (text: string): Tip => ({ text, about: "aihub" });
const agents = (text: string): Tip => ({ text, about: "agents" });

export const TIPS: readonly Tip[] = [
  aihub("Shift+Tab switches between build, plan and auto mode."),
  aihub("/undo puts back the files the last turn changed."),
  aihub("/kb lets the agent answer from your own documents."),
  aihub("/schedule runs agents on a timetable while aihub-code is open."),
  aihub("/models rates how well each model fits your hardware."),
  aihub("Ctrl+P opens a palette with every window and action."),
  aihub("Ctrl+V pastes an image for a vision model to look at."),
  aihub("aihub-code --continue picks up this folder's last session."),
  aihub("An AGENTS.md in your project is read into every session."),
  aihub("/memory edits what AIhub remembers about you across chats."),
  aihub("/agent chat talks to AIhub's plain chat, without tools."),
  aihub("/compact summarizes the conversation to free up context."),
  aihub("aihub-code -p runs one task without the UI, for scripts."),
  aihub("Models ending in :cloud run on ollama.com, not on your machine."),
  aihub("/mcp connects Google, GitHub and other services to the agent."),
  aihub("/skill <name> gives the agent a ready-made set of instructions."),
  aihub("/rules lists the tool calls you allowed for good."),
  aihub("/hardware shows what this machine and your Ollama server have."),
  agents("An agent is a model in a loop: plan, call a tool, read, repeat."),
  agents("Plan mode lets an agent read and think before it edits anything."),
  agents("MCP is an open protocol that plugs tools into any agent."),
  agents("RAG hands a model the relevant snippets, not whole documents."),
  agents("A tool call is the model asking your program to act for it."),
  agents("Small models do better with short, concrete tasks."),
  agents("Context is a model's working memory, and it fills up."),
  agents("Embeddings turn text into vectors, so meaning can be searched."),
  agents("Approving risky tool calls keeps a human in the agent's loop."),
  agents("A good AGENTS.md tells the agent how to build and test."),
  agents("Agents do best when they can check their work with tests."),
  agents("Temperature 0 makes answers repeatable; higher adds variety."),
];

/** A random tip that fits `width` columns (one space in, the prefix, the
 *  sentence); null when none does. */
export function pickTip(width: number, random: () => number = Math.random): string | null {
  const fit = TIPS.filter((t) => 1 + TIP_PREFIX.length + t.text.length <= width);
  if (fit.length === 0) return null;
  return fit[Math.min(fit.length - 1, Math.floor(random() * fit.length))]!.text;
}
