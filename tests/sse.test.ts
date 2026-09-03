import { describe, expect, it } from "vitest";
import { parseSse, transformAnthropicSseToOpenAi } from "../src/server/protocol/sse.js";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
      controller.enqueue(bytes.slice(Math.floor(bytes.length / 2)));
      controller.close();
    },
  });
}

describe("SSE state machine", () => {
  it("parses split CRLF events and multiline data", async () => {
    const events = [];
    for await (const event of parseSse(streamOf("event: ping\r\ndata: one\r\ndata: two\r\n\r\n"))) events.push(event);
    expect(events).toEqual([{ event: "ping", data: "one\ntwo" }]);
  });

  it("transforms text and tool deltas without buffering the response", async () => {
    const source = [
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":5}}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool_1\",\"name\":\"search\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"q\\\":\\\"x\\\"}\"}}\n\n",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":7}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ].join("");
    let measured = { input: 0, output: 0 };
    const output = await new Response(transformAnthropicSseToOpenAi(streamOf(source), "claude-public", (usage) => { measured = usage; })).text();
    expect(output).toContain("Hello");
    expect(output).toContain("tool_calls");
    expect(output).not.toContain("partial_json");
    expect(output).toContain("\"finish_reason\":\"tool_calls\"");
    expect(output).toContain("data: [DONE]");
    expect(measured).toEqual({ input: 5, output: 7 });
  });
});
