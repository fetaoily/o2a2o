// Shared Intermediate Representation for all protocol converters.

export type IRContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: unknown };

export interface IRMessage { role: "user" | "assistant" | "tool"; content: string | IRContentPart[] }

export interface IRRequest {
  model: string; system?: string; messages: IRMessage[];
  tools?: { name: string; description?: string; parameters: unknown }[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  disableParallelToolUse?: boolean;
  temperature?: number; topP?: number; maxTokens: number; stop?: string[];
  stream: boolean; effort?: string; structuredOutput?: unknown;
}

export interface IRResponse {
  id: string; model: string; content: IRContentPart[];
  stopReason: "stop" | "length" | "tool_use" | "content_filter";
  usage: { inputTokens: number; outputTokens: number };
}
