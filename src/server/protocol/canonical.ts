import { z } from "zod";
import type {
  CanonicalBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
} from "../domain.js";
import { HttpError } from "../http-error.js";

const genericBody = z.object({
  model: z.string().min(1),
  messages: z.array(z.record(z.string(), z.unknown())).min(1),
}).passthrough();

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`, "invalid_request_error");
  return value;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    const block = asRecord(item);
    return block.type === "text" || block.type === "input_text" || block.type === "output_text" ? String(block.text ?? "") : "";
  }).join("");
}

function openAiImageSource(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const raw = typeof value === "string" ? value : record.url;
  const url = requireString(raw, "image_url.url");
  const dataMatch = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataMatch) return { type: "base64", media_type: dataMatch[1], data: dataMatch[2] };
  return { type: "url", url };
}

function openAiContent(content: unknown): CanonicalBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new HttpError(400, "Message content must be a string or array", "invalid_request_error");
  return content.map((item): CanonicalBlock => {
    const block = asRecord(item);
    switch (block.type) {
      case "text":
      case "input_text":
      case "output_text":
        return { type: "text", text: requireString(block.text, "content.text") };
      case "image_url":
      case "input_image":
        return { type: "image", source: openAiImageSource(block.image_url ?? block.image) };
      default:
        throw new HttpError(400, `Unsupported OpenAI content block: ${String(block.type)}`, "unsupported_content_block");
    }
  });
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch {
    throw new HttpError(400, "Tool call arguments must contain valid JSON", "invalid_tool_arguments");
  }
}

function openAiTools(value: unknown): CanonicalTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "tools must be an array", "invalid_request_error");
  return value.map((item): CanonicalTool => {
    const tool = asRecord(item);
    if (tool.type !== "function") throw new HttpError(400, "Only function tools are supported", "unsupported_tool_type");
    const fn = asRecord(tool.function);
    const result: CanonicalTool = {
      name: requireString(fn.name, "tools.function.name"),
      input_schema: asRecord(fn.parameters),
    };
    if (typeof fn.description === "string") result.description = fn.description;
    return result;
  });
}

function openAiToolChoice(value: unknown): unknown {
  if (value === undefined || value === "auto") return { type: "auto" };
  if (value === "none") return { type: "none" };
  if (value === "required") return { type: "any" };
  const record = asRecord(value);
  const fn = asRecord(record.function);
  if (record.type === "function" && typeof fn.name === "string") return { type: "tool", name: fn.name };
  throw new HttpError(400, "Unsupported tool_choice", "invalid_tool_choice");
}

function responseFormatToOutputConfig(value: unknown, reasoningEffort: unknown): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  if (typeof reasoningEffort === "string") output.effort = reasoningEffort;
  if (value !== undefined) {
    const format = asRecord(value);
    if (format.type === "text") {
      // Text is the native default.
    } else if (format.type === "json_schema") {
      const jsonSchema = asRecord(format.json_schema);
      output.format = { type: "json_schema", schema: asRecord(jsonSchema.schema) };
    } else {
      throw new HttpError(400, "Only text and json_schema response formats are supported", "unsupported_response_format");
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function normalizeOpenAiRequest(input: unknown): CanonicalRequest {
  const body = genericBody.parse(input);
  const system: CanonicalBlock[] = [];
  const messages: CanonicalMessage[] = [];
  for (const rawMessage of body.messages) {
    const role = rawMessage.role;
    if (role === "system" || role === "developer") {
      system.push(...openAiContent(rawMessage.content));
      continue;
    }
    if (role === "tool") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: requireString(rawMessage.tool_call_id, "tool_call_id"),
          content: contentToText(rawMessage.content),
        }],
      });
      continue;
    }
    if (role !== "user" && role !== "assistant") throw new HttpError(400, `Unsupported message role: ${String(role)}`, "invalid_role");
    const content = openAiContent(rawMessage.content);
    if (role === "assistant" && Array.isArray(rawMessage.tool_calls)) {
      for (const rawCall of rawMessage.tool_calls) {
        const call = asRecord(rawCall);
        const fn = asRecord(call.function);
        content.push({
          type: "tool_use",
          id: requireString(call.id, "tool_calls.id"),
          name: requireString(fn.name, "tool_calls.function.name"),
          input: parseToolArguments(fn.arguments),
        });
      }
    }
    messages.push({ role, content });
  }
  const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens ?? 4096);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new HttpError(400, "max_tokens must be a positive integer", "invalid_max_tokens");
  const request: CanonicalRequest = {
    model: body.model,
    system,
    messages,
    tools: openAiTools(body.tools),
    maxTokens,
    stream: body.stream === true,
  };
  if (body.tools !== undefined) request.toolChoice = openAiToolChoice(body.tool_choice);
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.topP = body.top_p;
  if (typeof body.stop === "string") request.stopSequences = [body.stop];
  if (Array.isArray(body.stop)) request.stopSequences = body.stop.filter((item): item is string => typeof item === "string");
  if (typeof body.user === "string") request.metadata = { user_id: body.user };
  const outputConfig = responseFormatToOutputConfig(body.response_format, body.reasoning_effort);
  if (outputConfig) request.outputConfig = outputConfig;
  if (typeof body.service_tier === "string") request.serviceTier = body.service_tier;
  return request;
}

function anthropicBlock(input: unknown): CanonicalBlock {
  const block = asRecord(input);
  const metadata = (): Pick<CanonicalBlock, "cacheControl" | "extras"> => {
    const result: Pick<CanonicalBlock, "cacheControl" | "extras"> = {};
    if (block.cache_control && typeof block.cache_control === "object") result.cacheControl = asRecord(block.cache_control);
    const known = new Set(["type", "text", "source", "title", "thinking", "signature", "id", "name", "input", "tool_use_id", "content", "is_error", "cache_control"]);
    const extras = Object.fromEntries(Object.entries(block).filter(([key]) => !known.has(key)));
    if (Object.keys(extras).length > 0) result.extras = extras;
    return result;
  };
  switch (block.type) {
    case "text": return { type: "text", text: requireString(block.text, "content.text"), ...metadata() };
    case "image": return { type: "image", source: asRecord(block.source), ...metadata() };
    case "document": {
      const result: CanonicalBlock = { type: "document", source: asRecord(block.source), ...metadata() };
      if (typeof block.title === "string") result.title = block.title;
      return result;
    }
    case "thinking": {
      const result: CanonicalBlock = { type: "thinking", thinking: requireString(block.thinking, "content.thinking"), ...metadata() };
      if (typeof block.signature === "string") result.signature = block.signature;
      return result;
    }
    case "tool_use": return {
      type: "tool_use",
      id: requireString(block.id, "content.id"),
      name: requireString(block.name, "content.name"),
      input: block.input ?? {},
      ...metadata(),
    };
    case "tool_result": {
      const result: CanonicalBlock = {
        type: "tool_result",
        tool_use_id: requireString(block.tool_use_id, "content.tool_use_id"),
        content: typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content) ? block.content.map(anthropicBlock) : "",
        ...metadata(),
      };
      if (typeof block.is_error === "boolean") result.is_error = block.is_error;
      return result;
    }
    default: return { type: "native", value: block };
  }
}

function anthropicContent(content: unknown): CanonicalBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new HttpError(400, "Message content must be a string or array", "invalid_request_error");
  return content.map(anthropicBlock);
}

export function normalizeAnthropicRequest(input: unknown): CanonicalRequest {
  const body = genericBody.parse(input);
  const messages = body.messages.map((message): CanonicalMessage => {
    if (message.role !== "user" && message.role !== "assistant") throw new HttpError(400, "Anthropic messages must use user or assistant roles", "invalid_role");
    return { role: message.role, content: anthropicContent(message.content) };
  });
  const tools: CanonicalTool[] = Array.isArray(body.tools) ? body.tools.map((item) => {
    const tool = asRecord(item);
    const result: CanonicalTool = {
      name: requireString(tool.name, "tools.name"),
      input_schema: asRecord(tool.input_schema),
    };
    if (typeof tool.description === "string") result.description = tool.description;
    if (tool.cache_control && typeof tool.cache_control === "object") result.cacheControl = asRecord(tool.cache_control);
    return result;
  }) : [];
  const maxTokens = Number(body.max_tokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new HttpError(400, "max_tokens must be a positive integer", "invalid_max_tokens");
  const request: CanonicalRequest = {
    model: body.model,
    system: body.system === undefined ? [] : anthropicContent(body.system),
    messages,
    tools,
    maxTokens,
    stream: body.stream === true,
  };
  if (body.tool_choice !== undefined) request.toolChoice = body.tool_choice;
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.topP = body.top_p;
  if (typeof body.top_k === "number") request.topK = body.top_k;
  if (Array.isArray(body.stop_sequences)) request.stopSequences = body.stop_sequences.filter((item): item is string => typeof item === "string");
  if (body.metadata && typeof body.metadata === "object") request.metadata = asRecord(body.metadata);
  if (body.thinking !== undefined) request.thinking = body.thinking;
  if (body.output_config && typeof body.output_config === "object") request.outputConfig = asRecord(body.output_config);
  if (typeof body.service_tier === "string") request.serviceTier = body.service_tier;
  return request;
}

function canonicalToAnthropicBlock(block: CanonicalBlock): Record<string, unknown> {
  const decorate = (value: Record<string, unknown>): Record<string, unknown> => ({
    ...(block.extras ?? {}),
    ...value,
    ...(block.cacheControl ? { cache_control: block.cacheControl } : {}),
  });
  switch (block.type) {
    case "text": return decorate({ type: "text", text: block.text });
    case "image": return decorate({ type: "image", source: block.source });
    case "document": return decorate({ type: "document", source: block.source, ...(block.title ? { title: block.title } : {}) });
    case "thinking": return decorate({ type: "thinking", thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) });
    case "tool_use": return decorate({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    case "tool_result": return decorate({
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: typeof block.content === "string" ? block.content : block.content.map(canonicalToAnthropicBlock),
      ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
    });
    case "native": return block.value;
  }
}

export function toAnthropicRequest(request: CanonicalRequest, upstreamModel: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: upstreamModel,
    max_tokens: request.maxTokens,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content.map(canonicalToAnthropicBlock),
    })),
    stream: request.stream,
  };
  if (request.system.length > 0) body.system = request.system.map(canonicalToAnthropicBlock);
  if (request.tools.length > 0) body.tools = request.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.input_schema,
    ...(tool.cacheControl ? { cache_control: tool.cacheControl } : {}),
  }));
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.topK !== undefined) body.top_k = request.topK;
  if (request.stopSequences !== undefined) body.stop_sequences = request.stopSequences;
  if (request.metadata !== undefined) body.metadata = request.metadata;
  if (request.thinking !== undefined) body.thinking = request.thinking;
  if (request.outputConfig !== undefined) body.output_config = request.outputConfig;
  if (request.serviceTier !== undefined) body.service_tier = request.serviceTier;
  return body;
}

function finishReason(stopReason: unknown): string | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "refusal": return "content_filter";
    case null:
    case undefined: return null;
    default: return "stop";
  }
}

export function anthropicResponseToOpenAi(input: unknown, publicModel: string): Record<string, unknown> {
  const response = asRecord(input);
  const content = Array.isArray(response.content) ? response.content.map(asRecord) : [];
  const text = content.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
  const thinking = content.filter((block) => block.type === "thinking").map((block) => String(block.thinking ?? "")).join("");
  const toolCalls = content.filter((block) => block.type === "tool_use").map((block) => ({
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
  }));
  const usage = asRecord(response.usage);
  const promptTokens = Number(usage.input_tokens ?? 0);
  const completionTokens = Number(usage.output_tokens ?? 0);
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (thinking) message.reasoning_content = thinking;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl_${String(response.id ?? crypto.randomUUID())}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: publicModel,
    choices: [{ index: 0, message, finish_reason: finishReason(response.stop_reason) }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: {
        cached_tokens: Number(usage.cache_read_input_tokens ?? 0),
      },
    },
  };
}

export function rewriteAnthropicResponse(input: unknown, publicModel: string): Record<string, unknown> {
  const response = asRecord(input);
  return { ...response, model: publicModel };
}

export function mapStopReason(stopReason: unknown): string | null {
  return finishReason(stopReason);
}
