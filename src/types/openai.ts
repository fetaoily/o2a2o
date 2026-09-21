// Loose annotations of the openai_chat wire shapes. Internal use only;
// intentionally not exhaustive — unknown fields pass through index signatures.

export interface ChatFunctionDef {
  name?: string;
  description?: string;
  parameters?: unknown;
  arguments?: string;
}

export interface ChatToolCall {
  id?: string;
  type?: string;
  function?: ChatFunctionDef;
}

export interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: { type?: string; function?: ChatFunctionDef }[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  reasoning_effort?: string;
  response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown } };
  n?: number;
  [key: string]: unknown;
}

export interface ChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: {
    index?: number;
    message?: { role?: string; content?: unknown; tool_calls?: ChatToolCall[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  [key: string]: unknown;
}
