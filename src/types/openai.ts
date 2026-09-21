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

// Loose annotations of the openai_responses wire shapes. Internal use only;
// intentionally not exhaustive — unknown fields pass through index signatures.

export interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: unknown;
  tools?: { type?: string; name?: string; description?: string; parameters?: unknown }[];
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  reasoning?: { effort?: string };
  text?: { format?: { type?: string; json_schema?: { name?: string; schema?: unknown } } };
  [key: string]: unknown;
}

export interface ResponsesOutputItem {
  id?: string;
  type?: string;
  role?: string;
  status?: string;
  content?: { type?: string; text?: string }[];
  call_id?: string;
  name?: string;
  arguments?: string;
}

export interface ResponsesResponse {
  id?: string;
  object?: string;
  created_at?: number;
  status?: string;
  model?: string;
  incomplete_details?: { reason?: string };
  error?: { message?: string };
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
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
