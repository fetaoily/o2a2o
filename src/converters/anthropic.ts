// anthropic messages <-> IR converter.
import type { IRContentPart, IRMessage, IRRequest, IRResponse } from "../types/ir";
import type { AntBlock, AntResponse } from "../types/anthropic";
import type { ConvResult } from "./chat";
import { ParamError } from "./chat";

// anthropic content block -> IRContentPart. thinking blocks are dropped with a
// debug log; unknown types are skipped. Blocks carrying cache_control have it
// stripped and "cache_control" is recorded in `dropped` (once per request).
function mapBlocks(content: unknown, dropped: string[]): IRContentPart[] {
  const parts: IRContentPart[] = [];
  if (!Array.isArray(content)) return parts;
  for (const block of content as AntBlock[]) {
    if (block?.cache_control !== undefined && !dropped.includes("cache_control"))
      dropped.push("cache_control");
    if (block?.type === "text") {
      parts.push({ type: "text", text: String(block.text) });
    } else if (block?.type === "tool_use") {
      parts.push({ type: "tool_use", id: block.id ?? "", name: block.name ?? "", input: block.input });
    } else if (block?.type === "tool_result") {
      parts.push({ type: "tool_result", toolUseId: block.tool_use_id ?? "", content: block.content });
    } else if (block?.type === "image" && block.source?.type === "base64") {
      parts.push({ type: "image", mediaType: block.source.media_type ?? "", data: block.source.data ?? "" });
    } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
      console.debug(`[anthropic] dropping ${block.type} block`);
    } else {
      console.warn(`[anthropic] skipping unsupported content block type: ${String(block?.type)}`);
    }
  }
  return parts;
}

// anthropic tool_choice -> IR toolChoice. Unknown shapes fall back to undefined.
function toIrToolChoice(tc: any): IRRequest["toolChoice"] {
  if (!tc || typeof tc !== "object") return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "none") return "none";
  if (tc.type === "tool" && typeof tc.name === "string") return { name: tc.name };
  return undefined;
}

export function anthropicToIr(body: unknown): ConvResult {
  const b = body as any;
  if (b.stream === true)
    throw new ParamError("streaming is not supported in this gateway version (planned for M2)");
  const dropped: string[] = [];
  if (b.metadata !== undefined) dropped.push("metadata");
  let system: string | undefined;
  if (typeof b.system === "string") system = b.system;
  else if (Array.isArray(b.system))
    system = b.system
      .filter((s: AntBlock) => s?.type === "text" && typeof s.text === "string")
      .map((s: AntBlock) => s.text)
      .join("\n\n") || undefined;
  const messages: IRMessage[] = [];
  for (const m of b.messages ?? []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const parts = mapBlocks(m.content, dropped);
    // anthropic carries tool results inside user messages; IR models them
    // as tool-role messages when tool_result blocks are all the content.
    if (m.role === "user" && parts.length > 0 && parts.every((p) => p.type === "tool_result"))
      messages.push({ role: "tool", content: parts });
    else messages.push({ role: m.role, content: parts });
  }
  return {
    ir: {
      model: b.model, system, messages,
      tools: b.tools?.map((t: any) => ({ name: t.name, description: t.description, parameters: t.input_schema })),
      toolChoice: toIrToolChoice(b.tool_choice),
      disableParallelToolUse: b.tool_choice?.disable_parallel_tool_use === true || undefined,
      temperature: b.temperature, topP: b.top_p,
      maxTokens: b.max_tokens,
      stop: b.stop_sequences,
      stream: b.stream === true,
      effort: b.output_config?.effort,
      structuredOutput: b.output_config?.format?.schema,
    },
    dropped,
  };
}

// IRContentPart -> anthropic content block.
function partToBlock(p: IRContentPart): Record<string, unknown> {
  switch (p.type) {
    case "text": return { type: "text", text: p.text };
    case "image": return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } };
    case "tool_use": return { type: "tool_use", id: p.id, name: p.name, input: p.input };
    case "tool_result": return { type: "tool_result", tool_use_id: p.toolUseId, content: p.content };
  }
}

// IR toolChoice -> anthropic tool_choice. disable_parallel_tool_use applies
// only when the choice is auto or absent; a forced shape wins untouched.
function toolChoiceToAnthropic(ir: IRRequest): Record<string, unknown> | undefined {
  const dptu = ir.disableParallelToolUse === true;
  if (ir.toolChoice === undefined || ir.toolChoice === "auto")
    return dptu ? { type: "auto", disable_parallel_tool_use: true } : undefined;
  if (ir.toolChoice === "required") return { type: "any" };
  if (ir.toolChoice === "none") return { type: "none" };
  return { type: "tool", name: ir.toolChoice.name };
}

export function irToAnthropic(ir: IRRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const m of ir.messages) {
    if (m.role === "tool") {
      // anthropic requires tool_result blocks to ride on user messages;
      // consecutive tool messages merge into a single user message.
      const blocks = (Array.isArray(m.content) ? m.content : []).map(partToBlock);
      const prev = messages[messages.length - 1];
      if (prev?.role === "user" && Array.isArray(prev.content)) prev.content.push(...blocks);
      else messages.push({ role: "user", content: blocks });
      continue;
    }
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    // plain string content unless the part list is genuinely multi-part
    if (m.content.length === 1 && m.content[0].type === "text") {
      messages.push({ role: m.role, content: m.content[0].text });
      continue;
    }
    messages.push({ role: m.role, content: m.content.map(partToBlock) });
  }
  const out: Record<string, unknown> = {
    model: ir.model,
    messages,
    max_tokens: ir.maxTokens,
    stream: ir.stream,
  };
  if (ir.system !== undefined) out.system = ir.system;
  if (ir.temperature !== undefined) out.temperature = ir.temperature;
  if (ir.topP !== undefined) out.top_p = ir.topP;
  if (ir.stop !== undefined) out.stop_sequences = ir.stop;
  if (ir.tools && ir.tools.length > 0)
    out.tools = ir.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const tool_choice = toolChoiceToAnthropic(ir);
  if (tool_choice !== undefined) out.tool_choice = tool_choice;
  if (ir.structuredOutput !== undefined || ir.effort !== undefined) {
    const output_config: Record<string, unknown> = {};
    if (ir.structuredOutput !== undefined)
      output_config.format = { type: "json_schema", schema: ir.structuredOutput };
    if (ir.effort !== undefined) output_config.effort = ir.effort;
    out.output_config = output_config;
  }
  return out;
}

// anthropic stop_reason -> IR stopReason. pause_turn is folded into stop.
const STOP_TO_IR: Record<string, IRResponse["stopReason"]> = {
  end_turn: "stop", stop_sequence: "stop", max_tokens: "length",
  tool_use: "tool_use", refusal: "content_filter", pause_turn: "stop",
};

export function anthropicResponseToIr(res: unknown): IRResponse {
  const r = (res ?? {}) as AntResponse;
  const parts: IRContentPart[] = [];
  for (const block of r.content ?? []) {
    if (block?.type === "text") {
      parts.push({ type: "text", text: String(block.text) });
    } else if (block?.type === "tool_use") {
      parts.push({ type: "tool_use", id: block.id ?? "", name: block.name ?? "", input: block.input });
    } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
      console.debug(`[anthropic] dropping ${block.type} block`);
    } else {
      console.warn(`[anthropic] skipping unsupported content block type: ${String(block?.type)}`);
    }
  }
  if (r.stop_reason === "pause_turn")
    console.warn("[anthropic] stop_reason pause_turn mapped to stop");
  return {
    id: r.id ?? "",
    model: r.model ?? "",
    content: parts,
    stopReason: STOP_TO_IR[r.stop_reason ?? ""] ?? "stop",
    usage: { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 },
  };
}

// IR stopReason -> anthropic stop_reason.
const IR_TO_STOP: Record<IRResponse["stopReason"], string> = {
  stop: "end_turn", length: "max_tokens", tool_use: "tool_use", content_filter: "refusal",
};

export function irToAnthropicResponse(ir: IRResponse): Record<string, unknown> {
  return {
    id: ir.id,
    type: "message",
    role: "assistant",
    model: ir.model,
    content: ir.content.map(partToBlock),
    stop_reason: IR_TO_STOP[ir.stopReason],
    stop_sequence: null,
    usage: { input_tokens: ir.usage.inputTokens, output_tokens: ir.usage.outputTokens },
  };
}
