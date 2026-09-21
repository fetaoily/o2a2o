// openai_responses <-> IR converter. The Responses wire format has no stop
// parameter: never emitted outbound, recorded in `dropped` if seen inbound.
import type { IRContentPart, IRMessage, IRRequest, IRResponse } from "../types/ir";
import type { ResponsesRequest, ResponsesResponse } from "../types/openai";
import type { ConvResult } from "./chat";
import { ParamError, imageUrl, toolResultToString } from "./chat";

// Structural params with no IR equivalent: recorded in `dropped`, never applied.
const DROPPED = ["verbosity", "previous_response_id", "store", "truncation", "metadata"] as const;

// Responses message-item content part types that carry plain text.
const TEXT_PART_TYPES = new Set(["input_text", "output_text", "summary_text"]);

// openai_responses message-item content -> string | IRContentPart[].
// A single text part stays a plain string; multiple parts become an array.
function itemToContent(content: unknown): string | IRContentPart[] {
  if (typeof content === "string") return content;
  const parts: IRContentPart[] = [];
  if (!Array.isArray(content)) return parts;
  for (const p of content) {
    if (p?.type && TEXT_PART_TYPES.has(p.type) && typeof p.text === "string")
      parts.push({ type: "text", text: p.text });
    else console.warn(`[openai_responses] skipping unsupported content part type: ${String(p?.type)}`);
  }
  const [first] = parts;
  return parts.length === 1 && first?.type === "text" ? first.text : parts;
}

export function responsesToIr(body: unknown): ConvResult {
  const b = body as ResponsesRequest;
  if ((b.text as any)?.format?.type === "json_object")
    throw new ParamError('text.format json_object is not supported; use {"type":"json_schema"}');
  const dropped: string[] = [...DROPPED.filter((p) => (b as any)[p] !== undefined)];
  if ((b as any).stop !== undefined) dropped.push("stop");
  const systemParts: string[] = [];
  const messages: IRMessage[] = [];
  if (typeof b.input === "string") {
    messages.push({ role: "user", content: b.input });
  } else if (Array.isArray(b.input)) {
    for (const item of b.input) {
      if (item?.type === "message") {
        if (item.role === "system" || item.role === "developer") {
          // IR messages have no system role; fold into system text like chatToIr.
          const text = itemToContent(item.content);
          systemParts.push(typeof text === "string"
            ? text
            : text.filter((p): p is Extract<IRContentPart, { type: "text" }> => p.type === "text").map((p) => p.text).join(""));
          continue;
        }
        messages.push({ role: item.role as IRMessage["role"], content: itemToContent(item.content) });
      } else if (item?.type === "function_call") {
        let input: unknown;
        try { input = JSON.parse(item.arguments || "{}"); }
        catch { throw new ParamError(`malformed tool call arguments for ${String(item.name)}: not valid JSON`); }
        messages.push({
          role: "assistant",
          content: [{ type: "tool_use", id: item.call_id ?? "", name: item.name ?? "", input }],
        });
      } else if (item?.type === "function_call_output") {
        messages.push({
          role: "tool",
          content: [{ type: "tool_result", toolUseId: item.call_id ?? "", content: (item as any).output }],
        });
      } else {
        console.warn(`[openai_responses] skipping unsupported input item type: ${String(item?.type)}`);
      }
    }
  }
  return {
    ir: {
      model: (b as any).model,
      system: systemParts.join("\n\n") || b.instructions,
      messages,
      tools: b.tools?.map((t) => ({ name: t.name ?? "", description: t.description, parameters: t.parameters })),
      toolChoice: normalizeToolChoice(b.tool_choice),
      temperature: b.temperature,
      topP: b.top_p,
      maxTokens: b.max_output_tokens ?? 4096,
      stop: undefined,
      stream: (b as any).stream === true,
      effort: b.reasoning?.effort,
      structuredOutput: (b.text as any)?.format?.type === "json_schema" ? (b.text as any).format.json_schema?.schema : undefined,
    },
    dropped,
  };
}

// openai_responses tool_choice -> IR toolChoice. Responses uses flat function
// tools: {type:"function", name} instead of chat's nested shape.
function normalizeToolChoice(tc: unknown): IRRequest["toolChoice"] {
  if (tc === "auto" || tc === "none" || tc === "required") return tc;
  if (tc && typeof tc === "object" && (tc as any).type === "function") {
    const name = (tc as any).name;
    if (typeof name === "string") return { name };
  }
  return undefined;
}

// IR message -> openai_responses input items. A tool_use part becomes its own
// function_call item; a tool message becomes a function_call_output item.
function messageToItems(m: IRMessage): Record<string, unknown>[] {
  if (m.role === "tool") {
    const part = Array.isArray(m.content)
      ? m.content.find((p): p is Extract<IRContentPart, { type: "tool_result" }> => p.type === "tool_result")
      : undefined;
    return [{ type: "function_call_output", call_id: part?.toolUseId, output: toolResultToString(part !== undefined ? part.content : m.content) }];
  }
  if (m.role === "assistant" && Array.isArray(m.content) && m.content.some((p) => p.type === "tool_use")) {
    const items: Record<string, unknown>[] = [];
    const text = m.content
      .filter((p): p is Extract<IRContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (text !== "") items.push(messageItem(m.role, text));
    for (const p of m.content)
      if (p.type === "tool_use")
        items.push({ type: "function_call", call_id: p.id, name: p.name, arguments: JSON.stringify(p.input) });
    return items;
  }
  return [messageItem(m.role, m.content)];
}

// IR message -> openai_responses message item. Assistant text uses output_text,
// other roles use input_text; image parts serialize to input_image. Other part
// types are warned about and skipped.
function messageItem(role: string, content: string | IRContentPart[]): Record<string, unknown> {
  const partType = role === "assistant" ? "output_text" : "input_text";
  const c = typeof content === "string"
    ? [{ type: partType, text: content }]
    : content.flatMap((p): Record<string, unknown>[] => {
        if (p.type === "text") return [{ type: partType, text: p.text }];
        if (p.type === "image") return [{ type: "input_image", image_url: imageUrl(p) }];
        console.warn(`[openai_responses] skipping unsupported content part type: ${String(p.type)}`);
        return [];
      });
  return { type: "message", role, content: c };
}

export function irToResponses(ir: IRRequest): Record<string, unknown> {
  const items: Record<string, unknown>[] = [];
  for (const m of ir.messages) items.push(...messageToItems(m));
  const out: Record<string, unknown> = {
    model: ir.model,
    input: items,
    max_output_tokens: ir.maxTokens,
    stream: ir.stream,
  };
  if (ir.system !== undefined) out.instructions = ir.system;
  if (ir.temperature !== undefined) out.temperature = ir.temperature;
  if (ir.topP !== undefined) out.top_p = ir.topP;
  if (ir.tools && ir.tools.length > 0)
    out.tools = ir.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
  if (ir.toolChoice !== undefined)
    out.tool_choice = typeof ir.toolChoice === "string"
      ? ir.toolChoice
      : { type: "function", name: ir.toolChoice.name };
  if (ir.structuredOutput !== undefined)
    out.text = { format: { type: "json_schema", json_schema: { schema: ir.structuredOutput } } };
  if (ir.effort !== undefined) out.reasoning = { effort: ir.effort };
  return out;
}

export function responsesResponseToIr(res: unknown): IRResponse {
  const r = (res ?? {}) as ResponsesResponse;
  const parts: IRContentPart[] = [];
  for (const item of r.output ?? []) {
    if (item?.type === "message") {
      const texts = (item.content ?? [])
        .filter((p) => p?.type === "output_text" && typeof p.text === "string")
        .map((p) => p.text);
      if (texts.length > 0) parts.push({ type: "text", text: texts.join("") });
    } else if (item?.type === "function_call") {
      let input: unknown;
      try { input = JSON.parse(item.arguments || "{}"); }
      catch {
        // upstream data, not a client error: degrade instead of failing the request
        input = {};
        console.warn(`[openai_responses] malformed function_call arguments from upstream for ${String(item.name)}, degrading to empty input`);
      }
      parts.push({ type: "tool_use", id: item.call_id ?? "", name: item.name ?? "", input });
    } else {
      console.warn(`[openai_responses] skipping unsupported output item type: ${String(item?.type)}`);
    }
  }
  let stopReason: IRResponse["stopReason"] = "stop";
  if (r.status === "incomplete" && r.incomplete_details?.reason === "max_output_tokens") stopReason = "length";
  else if (r.status === "failed") {
    stopReason = "content_filter";
    if (r.error?.message) {
      console.warn(`[openai_responses] response failed: ${r.error.message}`);
      parts.push({ type: "text", text: r.error.message });
    }
  } else if (parts.some((p) => p.type === "tool_use")) stopReason = "tool_use";
  return {
    id: r.id ?? "",
    model: r.model ?? "",
    content: parts,
    stopReason,
    usage: { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 },
  };
}

export function irToResponsesResponse(ir: IRResponse): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  const text = ir.content
    .filter((p): p is Extract<IRContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
  if (text !== "")
    output.push({
      id: `msg_${ir.id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  for (const p of ir.content)
    if (p.type === "tool_use")
      output.push({ type: "function_call", call_id: p.id, name: p.name, arguments: JSON.stringify(p.input), status: "completed" });
  return {
    id: ir.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: ir.model,
    output,
    usage: {
      input_tokens: ir.usage.inputTokens,
      output_tokens: ir.usage.outputTokens,
      total_tokens: ir.usage.inputTokens + ir.usage.outputTokens,
    },
  };
}
