"""SSE event serialization for OpenAI-compatible responses."""

from typing import AsyncIterator, Optional, Dict, Any
import json

from loguru import logger

from app.services.sse import (
    parse_sse_stream,
    parse_sse_event_data,
    serialize_openai_sse_event,
)


class EventSerializer:
    """
    Serialize Claude SSE events into OpenAI SSE stream format.
    """

    async def serialize_stream(self, event_stream: AsyncIterator[Any]) -> AsyncIterator[str]:
        """
        Convert an async iterator of parsed events to SSE string stream.

        Args:
            event_stream: Iterator of StreamingEvent objects

        Yields:
            SSE-formatted strings for the response
        """
        # Emit initial message_start event
        yield self._serialize_message_start()

        tool_calls_started = False
        tool_calls_first_chunk = False
        current_tool_call_id = None
        current_tool_name = None
        current_tool_args = ""

        async for event in event_stream:
            # Handle both pydantic RootModel and dict-based events
            if isinstance(event, dict):
                event_type = event.get('type')
                event_data = event.get('data', event)
            elif hasattr(event, 'root'):
                # Pydantic RootModel - access via root attribute
                root = event.root
                if hasattr(root, 'type'):
                    event_type = root.type
                else:
                    event_type = root.get('type') if isinstance(root, dict) else 'unknown'
                # Get data from root (may be the root itself for UnknownEvent)
                event_data = root.model_dump() if hasattr(root, 'model_dump') else (dict(root) if hasattr(root, '__dict__') else root)
            else:
                event_type = getattr(event, 'event_type', None)
                event_data = getattr(event, 'data', None)

            if not event_data or not event_type:
                continue

            try:
                # event_data may already be a dict or could be a JSON string
                if isinstance(event_data, str):
                    event_data = json.loads(event_data)
            except json.JSONDecodeError:
                logger.debug(f"Could not parse event data: {str(event_data)[:100]}")
                continue

            # Handle content block deltas
            if event_type == "content_block_delta":
                delta = event_data.get("delta", {})
                text = delta.get("text", "")
                input_json = delta.get("input_json", {})

                # Handle tool call arguments
                if tool_calls_started and current_tool_call_id:
                    if input_json:
                        # Extract partial JSON string directly, avoid double encoding
                        raw_str = input_json.get("partial_json", "") if isinstance(input_json, dict) else str(input_json)
                        current_tool_args += raw_str
                        yield self._serialize_tool_calls_delta(
                            current_tool_call_id, current_tool_name,
                            raw_str, is_first=tool_calls_first_chunk
                        )
                        tool_calls_first_chunk = False
                    continue

                if not text:
                    continue

                # Check for tool call patterns in text (XML-style)
                # Support both plain <invoke and \x08antml:invoke and atml:invoke formats
                if "<invoke " in text or "<atml:invoke" in text or "<\x08antml:invoke" in text:
                    continue

                # Check if we're inside a tool call block
                if tool_calls_started:
                    continue

                yield self._serialize_content_delta(text)

            # Handle content block start (tool use, thinking, etc.)
            elif event_type == "content_block_start":
                content_block = event_data.get("content_block", {})
                block_type = content_block.get("type")

                if block_type == "tool_use":
                    tool_calls_started = True
                    tool_calls_first_chunk = True
                    current_tool_call_id = content_block.get("id")
                    current_tool_name = content_block.get("name")
                    current_tool_args = ""
                    logger.debug(f"Tool call started: {current_tool_name}")

                yield self._serialize_content_block_start(content_block)

            # Handle content block stop
            elif event_type == "content_block_stop":
                content_block = event_data.get("content_block", {})
                block_type = content_block.get("type")

                if block_type == "tool_use" and current_tool_call_id:
                    yield self._serialize_tool_calls_finish(
                        current_tool_call_id,
                        current_tool_name,
                        current_tool_args
                    )
                    tool_calls_started = False

                yield self._serialize_content_block_stop()

            # Handle message delta
            elif event_type == "message_delta":
                delta = event_data.get("delta", {})
                stop_reason = delta.get("stop_reason")
                usage = event_data.get("usage")

                if usage:
                    yield self._serialize_usage(usage)

                if stop_reason:
                    # Map Claude stop_reason to OpenAI finish_reason
                    stop_reason_map = {
                        "tool_use": "tool_calls",
                        "end_turn": "stop",
                        "max_tokens": "length",
                        "stop_sequence": "stop",
                        "pause_turn": "stop",
                    }
                    mapped_reason = stop_reason_map.get(stop_reason, stop_reason)
                    yield self._serialize_finish_reason(mapped_reason)

            # Handle message stop
            elif event_type == "message_stop":
                # Yield final chunk with stop reason if not already sent
                if not tool_calls_started:
                    yield self._serialize_finish_reason("stop")

            # Handle error
            elif event_type == "error":
                error = event_data.get("error", {})
                yield self._serialize_error(error)

            # Handle ping
            elif event_type == "ping":
                continue

            # Handle other events
            else:
                logger.debug(f"Unhandled event type: {event_type}")

        # Final finish reason
        if not tool_calls_started:
            yield self._serialize_finish_reason("stop")

    def _serialize_message_start(self) -> str:
        """Serialize message start event."""
        event = {
            "id": self._generate_id(),
            "object": "chat.completion.chunk",
            "created": int(__import__('time').time()),
            "model": "claude",
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": ""},
                    "finish_reason": None,
                }
            ],
        }
        return serialize_openai_sse_event(event)

    def _serialize_content_delta(self, text: str) -> str:
        """Serialize content delta (text chunk)."""
        event = {
            "id": self._generate_id(),
            "object": "chat.completion.chunk",
            "created": int(__import__('time').time()),
            "model": "claude",
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": text},
                    "finish_reason": None,
                }
            ],
        }
        return serialize_openai_sse_event(event)

    def _serialize_tool_calls_delta(
        self, tool_call_id: str, name: str, args: str, is_first: bool = True
    ) -> str:
        """Serialize tool call delta.

        Per OpenAI spec:
        - First chunk includes id, type, and function.name
        - Subsequent chunks only include function.arguments (partial_json)
        """
        tool_call_obj = {"index": 0}

        if is_first:
            tool_call_obj["id"] = tool_call_id
            tool_call_obj["type"] = "function"
            tool_call_obj["function"] = {
                "name": name,
                "arguments": args,
            }
        else:
            # Subsequent chunks: only arguments
            tool_call_obj["function"] = {
                "arguments": args,
            }

        event = {
            "id": self._generate_id(),
            "object": "chat.completion.chunk",
            "created": int(__import__('time').time()),
            "model": "claude",
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [tool_call_obj]
                    },
                    "finish_reason": None,
                }
            ],
        }
        return serialize_openai_sse_event(event)

    def _serialize_tool_calls_finish(
        self, tool_call_id: str, name: str, args: str
    ) -> str:
        """Serialize final tool call chunk."""
        event = {
            "id": self._generate_id(),
            "object": "chat.completion.chunk",
            "created": int(__import__('time').time()),
            "model": "claude",
            "choices": [
                {
                    "index": 0,
                    "delta": {"tool_calls": [{"index": 0, "id": tool_call_id, "finish_reason": "tool_calls"}]},
                    "finish_reason": "tool_calls",
                }
            ],
        }
        return serialize_openai_sse_event(event)

    def _serialize_content_block_start(self, content_block: Dict[str, Any]) -> str:
        """Serialize content block start."""
        block_type = content_block.get("type")
        delta = {}

        if block_type == "tool_use":
            delta["tool_calls"] = [{
                "index": 0,
                "id": content_block.get("id"),
                "type": "function",
                "function": {
                    "name": content_block.get("name"),
                    "arguments": "",
                },
            }]
        elif block_type == "thinking":
            delta["content"] = ""
        elif block_type == "text":
            delta["content"] = ""

        event = {
            "id": self._generate_id(),
            "object": "chat.completion.chunk",
            "created": int(__import__('time').time()),
            "model": "claude",
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": None,
            }],
        }
        return serialize_openai_sse_event(event)

    def _serialize_content_block_stop(self) -> str:
        """Serialize content block stop."""
        # Content block stop doesn't need a separate SSE event in OpenAI format
        return ""

    def _serialize_finish_reason(self, reason: str, usage: Optional[Dict] = None) -> str:
        """Serialize finish reason."""
        delta = {}
        if usage:
            delta["usage"] = usage

        event = {
            "id": self._generate_id(),
            "object": "chat.completion.chunk",
            "created": int(__import__('time').time()),
            "model": "claude",
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": reason,
            }],
        }
        return serialize_openai_sse_event(event)

    def _serialize_usage(self, usage: Dict[str, Any]) -> str:
        """Serialize usage information."""
        openai_usage = {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
            "total_tokens": (
                usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
            ),
        }
        event = {
            "id": self._generate_id(),
            "object": "chat.completion.chunk",
            "created": int(__import__('time').time()),
            "model": "claude",
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": None,
            }],
        }
        return serialize_openai_sse_event(event)

    def _serialize_error(self, error: Dict[str, Any]) -> str:
        """Serialize an error event."""
        # For errors, we send the error content
        event = {
            "id": self._generate_id(),
            "object": "chat.completion.chunk",
            "created": int(__import__('time').time()),
            "model": "claude",
            "choices": [{
                "index": 0,
                "delta": {"content": f"[Error: {error.get('message', 'Unknown error')}]"},
                "finish_reason": "stop",
            }],
        }
        return serialize_openai_sse_event(event)

    def _generate_id(self) -> str:
        """Generate a request ID."""
        import uuid as uuid_lib
        return f"chatcmpl-{uuid_lib.uuid4().hex[:12]}"