// openai_chat <-> IR converter, including the parameter policy for
// structural params this gateway cannot honor (n > 1, json_object, ...).
import type { IRContentPart, IRMessage, IRRequest, IRResponse } from "../types/ir";
import type { ChatResponse } from "../types/openai";

export class ParamError extends Error {
  constructor(msg: string) { super(msg); this.name = "ParamError"; }
}

export interface ConvResult { ir: IRRequest; dropped: string[] }

// Structural params with no IR equivalent: recorded in `dropped`, never applied.
const DROPPED = ["presence_penalty","frequency_penalty","logit_bias","seed","logprobs",
  "top_logprobs","verbosity","prediction","web_search_options","store","service_tier",
  "safety_identifier","user","metadata"] as const;

const EFFORT: Record<string, IRRequest["effort"]> = {
  none: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh",
};

const FINISH_TO_STOP: Record<string, IRResponse["stopReason"]> = {
  stop: "stop", length: "length", tool_calls: "tool_use", content_filter: "content_filter",
};
const STOP_TO_FINISH: Record<IRResponse["stopReason"], string> = {
  stop: "stop", length: "length", tool_use: "tool_calls", content_filter: "content_filter",
};

// openai_chat multimodal content array -> IRContentPart[].
// data: URLs are split into mediaType + base64 payload; remote URLs are kept
// verbatim in `data` with mediaType "url". Unknown part types are skipped.
function mapContentParts(content: unknown): IRContentPart[] {
  const parts: IRContentPart[] = [];
  if (!Array.isArray(content)) return parts;
  for (const p of content) {
    if (p?.type === "text" && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
    } else if (p?.type === "image_url") {
      const url: unknown = p.image_url?.url;
      const dataMatch = typeof url === "string" ? url.match(/^data:([^;,]+);base64,([\s\S]*)$/) : null;
      if (dataMatch) parts.push({ type: "image", mediaType: dataMatch[1], data: dataMatch[2] });
      else if (typeof url === "string") parts.push({ type: "image", mediaType: "url", data: url });
      else console.warn("[openai_chat] skipping image_url content part without url");
    } else {
      console.warn(`[openai_chat] skipping unsupported content part type: ${String(p?.type)}`);
    }
  }
  return parts;
}

// openai_chat tool_choice -> IR toolChoice. Unknown shapes fall back to undefined.
function normalizeToolChoice(tc: unknown): IRRequest["toolChoice"] {
  if (tc === "auto" || tc === "none" || tc === "required") return tc;
  if (tc && typeof tc === "object" && (tc as any).type === "function") {
    const name = (tc as any).function?.name;
    if (typeof name === "string") return { name };
  }
  return undefined;
}

export function chatToIr(body: unknown): ConvResult {
  const b = body as any;
  if (b.n !== undefined && b.n > 1)
    throw new ParamError("`n` must be 1: target provider does not support multiple choices");
  const rf = b.response_format;
  if (rf?.type === "json_object")
    throw new ParamError('response_format json_object is not supported; use {"type":"json_schema"}');
  const dropped: string[] = [...DROPPED.filter((p) => b[p] !== undefined)];
  if (b.parallel_tool_calls === true) dropped.push("parallel_tool_calls");
  const system: string[] = []; const messages: IRMessage[] = [];
  for (const m of b.messages ?? []) {
    if (m.role === "system" || m.role === "developer") { system.push(String(m.content)); continue; }
    if (m.role === "tool") {
      messages.push({ role: "tool", content: [{ type: "tool_result", toolUseId: m.tool_call_id, content: m.content }] });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const parts: IRContentPart[] = [];
      if (m.content) parts.push({ type: "text", text: String(m.content) });
      for (const c of m.tool_calls)
        parts.push({ type: "tool_use", id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || "{}") });
      messages.push({ role: "assistant", content: parts }); continue;
    }
    messages.push({ role: m.role, content: typeof m.content === "string" ? m.content : mapContentParts(m.content) });
  }
  return {
    ir: {
      model: b.model, system: system.join("\n\n") || undefined, messages,
      tools: b.tools?.map((t: any) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
      toolChoice: normalizeToolChoice(b.tool_choice),
      disableParallelToolUse: b.parallel_tool_calls === false || undefined,
      temperature: b.temperature, topP: b.top_p,
      maxTokens: b.max_completion_tokens ?? b.max_tokens ?? 4096,
      stop: b.stop, stream: b.stream === true,
      effort: b.reasoning_effort ? EFFORT[b.reasoning_effort] : undefined,
      structuredOutput: rf?.type === "json_schema" ? rf.json_schema?.schema : undefined,
    },
    dropped,
  };
}

export function irToChat(ir: IRRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (ir.system !== undefined) messages.push({ role: "system", content: ir.system });
  for (const m of ir.messages) {
    if (m.role === "tool") {
      const part = Array.isArray(m.content)
        ? m.content.find((p): p is Extract<IRContentPart, { type: "tool_result" }> => p.type === "tool_result")
        : undefined;
      messages.push({ role: "tool", tool_call_id: part?.toolUseId, content: part ? String(part.content) : "" });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content) && m.content.some((p) => p.type === "tool_use")) {
      let text: string | null = null;
      const tool_calls: Record<string, unknown>[] = [];
      for (const p of m.content) {
        if (p.type === "text") text = (text ?? "") + p.text;
        else if (p.type === "tool_use")
          tool_calls.push({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } });
      }
      messages.push({ role: "assistant", content: text, tool_calls });
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }
  const out: Record<string, unknown> = {
    model: ir.model,
    messages,
    max_tokens: ir.maxTokens,
    stream: ir.stream,
  };
  if (ir.temperature !== undefined) out.temperature = ir.temperature;
  if (ir.topP !== undefined) out.top_p = ir.topP;
  if (ir.stop !== undefined) out.stop = ir.stop;
  if (ir.tools && ir.tools.length > 0)
    out.tools = ir.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (ir.toolChoice !== undefined)
    out.tool_choice = typeof ir.toolChoice === "string"
      ? ir.toolChoice
      : { type: "function", function: { name: ir.toolChoice.name } };
  if (ir.disableParallelToolUse) out.parallel_tool_calls = false;
  if (ir.effort !== undefined) out.reasoning_effort = ir.effort;
  return out;
}

export function chatResponseToIr(res: unknown): IRResponse {
  const r = (res ?? {}) as ChatResponse;
  const choice = r.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const parts: IRContentPart[] = [];
  if (typeof msg.content === "string" && msg.content) parts.push({ type: "text", text: msg.content });
  else if (msg.content) parts.push(...mapContentParts(msg.content));
  for (const c of msg.tool_calls ?? [])
    parts.push({ type: "tool_use", id: c.id ?? "", name: c.function?.name ?? "", input: JSON.parse(c.function?.arguments || "{}") });
  return {
    id: r.id ?? "",
    model: r.model ?? "",
    content: parts,
    stopReason: FINISH_TO_STOP[choice.finish_reason ?? ""] ?? "stop",
    usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 },
  };
}

// Concatenates text parts; null when the content has no text parts.
function joinText(content: IRContentPart[]): string | null {
  const texts = content
    .filter((p): p is Extract<IRContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text);
  return texts.length > 0 ? texts.join("") : null;
}

export function irToChatResponse(ir: IRResponse): Record<string, unknown> {
  const tool_calls = ir.content
    .filter((p): p is Extract<IRContentPart, { type: "tool_use" }> => p.type === "tool_use")
    .map((p) => ({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } }));
  return {
    id: ir.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: ir.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: joinText(ir.content), tool_calls: tool_calls.length > 0 ? tool_calls : null },
      finish_reason: STOP_TO_FINISH[ir.stopReason],
    }],
    usage: {
      prompt_tokens: ir.usage.inputTokens,
      completion_tokens: ir.usage.outputTokens,
      total_tokens: ir.usage.inputTokens + ir.usage.outputTokens,
    },
  };
}
