"""Tool call detection and handling in streaming responses."""

from typing import AsyncIterator, Optional
from loguru import logger

from app.processors.base import BaseProcessor
from app.processors.context import ClaudeAIContext
from app.models.streaming import (
    StreamingEvent,
    ContentBlockStartEvent,
    ContentBlockStopEvent,
    MessageDeltaEvent,
    MessageStopEvent,
    MessageDeltaData,
)
from app.services.tool_call_manager import tool_call_manager
from app.utils.messages import parse_tool_calls_from_text
import json
import re


class ToolCallEventProcessor(BaseProcessor):
    """
    Handle tool calls in the streaming response.

    This processor:
    1. Detects tool use content blocks from Claude
    2. Parses tool calls from text (if using web API format)
    3. Registers tool calls with the tool call manager
    4. Injects MessageDelta and MessageStop events for OpenAI compatibility
    5. Buffers text until tool calls are fully received
    """

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Process tool calls in the event stream.

        Requires:
            - event_stream in context
            - claude_session in context (for session_id)

        Produces:
            - Modified event_stream with tool call events handled
        """
        if not context.event_stream:
            logger.warning("Skipping ToolCallEventProcessor - no event_stream")
            return context

        if not context.claude_session:
            logger.warning("Skipping ToolCallEventProcessor - no session")
            return context

        original_stream = context.event_stream

        async def processed_stream():
            tool_use_id: Optional[str] = None
            content_block_index: Optional[int] = None
            tool_use_detected = False
            tool_result_detected = False
            text_buffer = ""

            async for event in original_stream:
                # Get event type from StreamingEvent
                if hasattr(event, 'root'):
                    root = event.root
                    event_type = getattr(root, 'type', root.get('type') if isinstance(root, dict) else 'unknown')
                    data = getattr(root, 'data', root) if not isinstance(root, dict) else root.get('data', {})
                else:
                    event_type = event.get('type') if isinstance(event, dict) else 'unknown'
                    data = event.get('data', {}) if isinstance(event, dict) else {}

                # Also check raw event data for tool use
                if isinstance(data, dict):
                    content_block = data.get("content_block", {})
                    if isinstance(content_block, dict):
                        block_type = content_block.get("type")

                        if block_type == "tool_use":
                            tool_use_detected = True
                            content_block_index = data.get("index")
                            tool_use_id = content_block.get("id")
                            name = content_block.get("name")
                            logger.debug(f"Tool use detected: {name} (id: {tool_use_id})")

                        elif block_type == "tool_result":
                            tool_result_detected = True

                    # Check for content block delta with tool call text
                    delta = data.get("delta", {})
                    if isinstance(delta, dict):
                        delta_type = delta.get("type")
                        if delta_type == "text_delta":
                            text = delta.get("text", "")
                            text_buffer += text

                            # Check if this is a tool call invocation
                            if "<invoke " in text or "<atml:invoke" in text:
                                # Parse tool calls from the buffered text
                                tool_calls = parse_tool_calls_from_text(
                                    text_buffer + text
                                )

                                if tool_calls and not tool_use_detected:
                                    # Tool calls detected in text format
                                    logger.info(f"Detected {len(tool_calls)} tool call(s) in text")

                                    # Register with tool call manager
                                    for tc in tool_calls:
                                        tool_use_id = tc.get("id")
                                        if tool_use_id and context.claude_session:
                                            tool_call_manager.register_tool_call(
                                                tool_use_id=tool_use_id,
                                                session_id=context.claude_session.session_id,
                                                message_id=context.collected_message.get("id") if context.collected_message else None,
                                            )

                                    context.tool_calls.extend(tool_calls)

                # Yield the event
                yield event

                # After content block stop for tool use, emit message delta
                if (event_type == "content_block_stop"
                    and isinstance(data, dict)
                    and data.get("index") == content_block_index
                    and tool_use_detected
                    and not tool_result_detected):

                    logger.debug(f"Tool use block ended, emitting message_delta")
                    message_delta = MessageDeltaEvent(
                        type="message_delta",
                        delta=MessageDeltaData(stop_reason="tool_use"),
                    )
                    yield message_delta

                    message_stop = MessageStopEvent(type="message_stop")
                    yield message_stop

                    break

            # Register tool calls if detected via text format
            if context.tool_calls and context.claude_session:
                logger.debug(f"Registered {len(context.tool_calls)} tool call(s)")

        context.event_stream = processed_stream()
        return context