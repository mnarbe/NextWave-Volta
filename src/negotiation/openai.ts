// -----------------------------------------------------------------------------
// negotiation/openai.ts
// Minimal Chat Completions client (fetch, no SDK — same style as the rest of the
// repo). Used by the round: the scripted carrier personas and the text-driven
// Volta both run on this.
// -----------------------------------------------------------------------------
import { config } from "../config.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

// Chat Completions tool shape. The Realtime tool defs in agent/tools.ts are
// {type,name,description,parameters}; wrap() converts them.
export type ChatTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
};

export function wrapTools(
  defs: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>
): ChatTool[] {
  return defs.map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

export type ChatChoice = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
};

type ChatOptions = {
  messages: ChatMessage[];
  tools?: ChatTool[];
  temperature?: number;
  model?: string;
};

export async function chat(opts: ChatOptions): Promise<ChatChoice> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: opts.model || config.openaiTextModel,
      messages: opts.messages,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
      temperature: opts.temperature ?? 0.4,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`chat.completions ${res.status}: ${body.slice(0, 300)}`);
  }

  const json: any = await res.json();
  const msg = json?.choices?.[0]?.message;
  if (!msg) throw new Error("chat.completions: empty response");
  return {
    role: "assistant",
    content: msg.content ?? null,
    tool_calls: msg.tool_calls,
  };
}
