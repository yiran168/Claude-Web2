import { describe, expect, it } from "vitest";
import {
  anthropicResponseToOpenAi,
  normalizeAnthropicRequest,
  normalizeOpenAiRequest,
  toAnthropicRequest,
} from "../src/server/protocol/canonical.js";

describe("protocol canonicalization", () => {
  it("preserves system text, images and tool calls from OpenAI input", () => {
    const canonical = normalizeOpenAiRequest({
      model: "claude-public",
      messages: [
        { role: "system", content: "Be precise." },
        { role: "user", content: [
          { type: "text", text: "What is shown?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
        ] },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "found" },
      ],
      tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object" } } }],
      tool_choice: "auto",
      max_completion_tokens: 512,
      stream: true,
    });
    expect(canonical.system).toEqual([{ type: "text", text: "Be precise." }]);
    expect(canonical.messages[0]?.content[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(canonical.messages[1]?.content[0]).toMatchObject({ type: "tool_use", id: "call_1", input: { q: "x" } });
    expect(canonical.messages[2]?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1" });
    const upstream = toAnthropicRequest(canonical, "claude-upstream");
    expect(upstream.model).toBe("claude-upstream");
    expect(upstream.stream).toBe(true);
    expect(upstream.tools).toEqual([{ name: "lookup", description: "Lookup", input_schema: { type: "object" } }]);
  });

  it("preserves Anthropic thinking and document blocks", () => {
    const canonical = normalizeAnthropicRequest({
      model: "claude-public",
      system: [{ type: "text", text: "Think carefully.", cache_control: { type: "ephemeral" } }],
      max_tokens: 256,
      thinking: { type: "enabled", budget_tokens: 128 },
      messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AA==" }, title: "Spec" }] }],
    });
    expect(canonical.thinking).toEqual({ type: "enabled", budget_tokens: 128 });
    expect(canonical.messages[0]?.content[0]).toMatchObject({ type: "document", title: "Spec" });
    expect(canonical.system[0]?.cacheControl).toEqual({ type: "ephemeral" });
    expect(toAnthropicRequest(canonical, "real").system).toEqual([{ type: "text", text: "Think carefully.", cache_control: { type: "ephemeral" } }]);
  });

  it("maps Anthropic responses to OpenAI including tools and usage", () => {
    const response = anthropicResponseToOpenAi({
      id: "msg_123",
      model: "real-model",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "Calling a tool." },
        { type: "tool_use", id: "tool_1", name: "weather", input: { city: "Paris" } },
      ],
      usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 4 },
    }, "claude-public");
    const choice = (response.choices as Array<Record<string, unknown>>)[0]!;
    const message = choice.message as Record<string, unknown>;
    expect(response.model).toBe("claude-public");
    expect(choice.finish_reason).toBe("tool_calls");
    expect(message.reasoning_content).toBe("reason");
    expect(message.tool_calls).toHaveLength(1);
    expect(response.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
  });
});
