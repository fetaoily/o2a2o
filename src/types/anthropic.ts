// Loose annotations of the anthropic messages wire shapes. Internal use only;
// intentionally not exhaustive — unknown fields pass through index signatures.

export interface AntBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: { type?: string; media_type?: string; data?: string };
  cache_control?: unknown;
  [key: string]: unknown;
}

export interface AntMessage {
  role?: string;
  content?: unknown; // string or AntBlock[]
}

export interface AntToolChoice {
  type?: string;
  name?: string;
  disable_parallel_tool_use?: boolean;
}

export interface AntRequest {
  model?: string;
  system?: unknown; // string or AntBlock[]
  messages?: AntMessage[];
  tools?: { name?: string; description?: string; input_schema?: unknown }[];
  tool_choice?: AntToolChoice;
  stop_sequences?: string[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  metadata?: unknown;
  output_config?: { format?: { type?: string; schema?: unknown }; effort?: string };
  [key: string]: unknown;
}

export interface AntResponse {
  id?: string;
  model?: string;
  content?: AntBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}
