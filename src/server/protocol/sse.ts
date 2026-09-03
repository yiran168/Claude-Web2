import { mapStopReason } from "./canonical.js";

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

const encoder = new TextEncoder();

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let eventId: string | undefined;
  let data: string[] = [];
  const emit = (): SseEvent | undefined => {
    if (data.length === 0) return undefined;
    const result: SseEvent = { data: data.join("\n") };
    if (eventName !== undefined) result.event = eventName;
    if (eventId !== undefined) result.id = eventId;
    eventName = undefined;
    data = [];
    return result;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const ready = emit();
          if (ready) yield ready;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const rawValue = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") eventName = rawValue;
        else if (field === "data") data.push(rawValue);
        else if (field === "id") eventId = rawValue;
      }
      if (done) break;
    }
    if (buffer.length > 0) data.push(buffer);
    const ready = emit();
    if (ready) yield ready;
  } finally {
    reader.releaseLock();
  }
}

function sseData(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

export function transformAnthropicSseToOpenAi(
  upstream: ReadableStream<Uint8Array>,
  publicModel: string,
  onUsage?: (usage: { input: number; output: number }) => void,
): ReadableStream<Uint8Array> {
  let messageId = `chatcmpl_${crypto.randomUUID()}`;
  let created = Math.floor(Date.now() / 1000);
  let toolIndex = -1;
  let finished = false;
  let inputTokens = 0;
  let outputTokens = 0;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, unknown>) => {
        const payload: Record<string, unknown> = {
          id: messageId,
          object: "chat.completion.chunk",
          created,
          model: publicModel,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        if (usage) payload.usage = usage;
        controller.enqueue(sseData(payload));
      };
      try {
        for await (const event of parseSse(upstream)) {
          if (event.data === "[DONE]") break;
          let data: Record<string, unknown>;
          try { data = asRecord(JSON.parse(event.data)); } catch { continue; }
          const type = String(data.type ?? event.event ?? "");
          if (type === "message_start") {
            const message = asRecord(data.message);
            if (typeof message.id === "string") messageId = `chatcmpl_${message.id}`;
            created = Math.floor(Date.now() / 1000);
            const usage = asRecord(message.usage);
            inputTokens = Number(usage.input_tokens ?? 0);
            onUsage?.({ input: inputTokens, output: outputTokens });
            chunk({ role: "assistant", content: "" });
          } else if (type === "content_block_start") {
            const block = asRecord(data.content_block);
            if (block.type === "tool_use") {
              toolIndex += 1;
              chunk({
                tool_calls: [{
                  index: toolIndex,
                  id: block.id,
                  type: "function",
                  function: { name: block.name, arguments: "" },
                }],
              });
            }
          } else if (type === "content_block_delta") {
            const delta = asRecord(data.delta);
            if (delta.type === "text_delta") chunk({ content: String(delta.text ?? "") });
            else if (delta.type === "thinking_delta") chunk({ reasoning_content: String(delta.thinking ?? "") });
            else if (delta.type === "input_json_delta") {
              chunk({ tool_calls: [{ index: Math.max(toolIndex, 0), function: { arguments: String(delta.partial_json ?? "") } }] });
            }
          } else if (type === "message_delta") {
            const delta = asRecord(data.delta);
            const usage = asRecord(data.usage);
            outputTokens = Number(usage.output_tokens ?? outputTokens);
            onUsage?.({ input: inputTokens, output: outputTokens });
            chunk({}, mapStopReason(delta.stop_reason), {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            });
            finished = true;
          } else if (type === "error") {
            controller.enqueue(sseData({ error: data.error ?? { message: "Upstream streaming error", type: "upstream_error" } }));
          }
        }
        if (!finished) chunk({}, "stop", {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void upstream.cancel(reason);
    },
  });
}

export function rewriteAnthropicSseModel(
  upstream: ReadableStream<Uint8Array>,
  publicModel: string,
  onUsage?: (usage: { input: number; output: number }) => void,
): ReadableStream<Uint8Array> {
  let inputTokens = 0;
  let outputTokens = 0;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of parseSse(upstream)) {
          let data = event.data;
          try {
            const parsed = asRecord(JSON.parse(data));
            if (parsed.type === "message_start") {
              parsed.message = { ...asRecord(parsed.message), model: publicModel };
              inputTokens = Number(asRecord(asRecord(parsed.message).usage).input_tokens ?? inputTokens);
              onUsage?.({ input: inputTokens, output: outputTokens });
              data = JSON.stringify(parsed);
            } else if (parsed.type === "message_delta") {
              outputTokens = Number(asRecord(parsed.usage).output_tokens ?? outputTokens);
              onUsage?.({ input: inputTokens, output: outputTokens });
              data = JSON.stringify(parsed);
            }
          } catch {
            // Preserve non-JSON events verbatim.
          }
          if (event.event) controller.enqueue(encoder.encode(`event: ${event.event}\n`));
          if (event.id) controller.enqueue(encoder.encode(`id: ${event.id}\n`));
          for (const line of data.split("\n")) controller.enqueue(encoder.encode(`data: ${line}\n`));
          controller.enqueue(encoder.encode("\n"));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { void upstream.cancel(reason); },
  });
}
