"""Message collection and response formatting processors."""

from typing import AsyncIterator
import time
import uuid as uuid_lib
from datetime import datetime

from loguru import logger
from fastapi.responses import StreamingResponse, JSONResponse

from app.processors.base import BaseProcessor
from app.processors.context import ClaudeAIContext
from app.services.event_serializer import EventSerializer
from app.models.streaming import (
    StreamingEvent,
    MessageStartEvent,
    ContentBlockDeltaEvent,
    MessageStopEvent,
    ErrorEvent,
)
from app.utils.messages import parse_tool_calls_from_text
import json


class MessageCollectorProcessor(BaseProcessor):
    """
    Collect the complete message from the event stream.

    For non-streaming responses, this consumes the entire stream
    and stores the complete message for later response generation.

    For streaming responses, this runs in parallel with the streaming
    response processor to capture token counts and tool calls.
    """

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Collect message content.

        Requires:
            - event_stream in context

        Produces:
            - collected_message in context (for non-streaming)
            - tool_calls in context (if any)
            - usage in context
        """
        if context.collected_message:
            logger.debug("Skipping MessageCollectorProcessor - already collected")
            return context

        if not context.event_stream:
            logger.warning("Skipping MessageCollectorProcessor - no event_stream")
            return context

        # For non-streaming requests, we need to consume the stream
        if not context.messages_request or not context.messages_request.stream:
            context.event_stream = self._collect_non_streaming(
                context.event_stream, context
            )
        else:
            # For streaming, we collect in the background
            context.event_stream = self._collect_streaming(
                context.event_stream, context
            )

        return context

    async def _collect_non_streaming(
        self, stream: AsyncIterator, context: ClaudeAIContext
    ) -> AsyncIterator:
        """Consume entire stream and build complete message."""
        full_content = ""
        tool_calls = []
        finish_reason = "stop"
        usage = None

        async for event in stream:
            # Get event data
            if hasattr(event, 'root'):
                root = event.root
                event_type = getattr(root, 'type', root.get('type') if isinstance(root, dict) else 'unknown')
                data = getattr(root, 'data', root) if not isinstance(root, dict) else root.get('data', {})
            else:
                event_type = event.get('type') if isinstance(event, dict) else 'unknown'
                data = event.get('data', {}) if isinstance(event, dict) else {}

            if isinstance(data, dict):
                # Collect text content
                delta = data.get("delta", {})
                if isinstance(delta, dict):
                    if delta.get("type") == "text_delta":
                        full_content += delta.get("text", "")

                # Collect tool calls
                if "content_block" in data:
                    block = data.get("content_block", {})
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        if "input" in block:
                            pass  # Will be collected via deltas

                # Check for stop reason
                if event_type == "message_delta":
                    delta_data = data.get("delta", {})
                    if isinstance(delta_data, dict):
                        stop_reason = delta_data.get("stop_reason")
                        if stop_reason:
                            finish_reason = stop_reason

                        usage = data.get("usage")
                        if usage:
                            context.usage = usage

                if event_type == "error":
                    error = data.get("error", {})
                    logger.error(f"Error in stream: {error}")

            yield event

        # Parse tool calls from content if using web API format
        if full_content:
            parsed_tools = parse_tool_calls_from_text(full_content)
            if parsed_tools:
                tool_calls = parsed_tools
                # Remove tool call text from content
                full_content = re.sub(
                    r'<invoke[^>]*>.*?</invoke>', '',
                    full_content,
                    flags=re.DOTALL
                )
                full_content = re.sub(
                    r'<function_calls>.*?</function_calls>',
                    '',
                    full_content,
                    flags=re.DOTALL
                ).strip()

        # Store collected message
        context.collected_message = {
            "id": context.request_id,
            "type": "message",
            "role": "assistant",
            "content": full_content if full_content else None,
            "model": context.model,
        }

        if tool_calls:
            context.collected_message["tool_calls"] = tool_calls
            context.tool_calls = tool_calls

        context.finish_reason = finish_reason

    async def _collect_streaming(
        self, stream: AsyncIterator, context: ClaudeAIContext
    ) -> AsyncIterator:
        """Collect while passing through for streaming."""
        async for event in stream:
            yield event

        logger.debug("Finished collecting streaming response")


class ModelInjectorProcessor(BaseProcessor):
    """
    Inject model name into streaming chunks.

    Claude doesn't include model name in every SSE chunk,
    so we inject it for OpenAI compatibility.
    """

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """Inject model name into events."""
        if not context.event_stream:
            return context

        model = context.model or "claude"

        original_stream = context.event_stream

        async def processed_stream():
            async for event in original_stream:
                # Add model to event data
                if hasattr(event, 'root'):
                    root = event.root
                    if hasattr(root, 'data') and isinstance(root.data, dict):
                        if 'model' not in root.data:
                            root.data['model'] = model
                yield event

        context.event_stream = processed_stream()
        return context


class StopSequencesProcessor(BaseProcessor):
    """Handle stop sequence detection in the response."""

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """Detect stop sequences and set finish_reason."""
        if not context.event_stream:
            return context

        # Stop sequences are handled by Claude already
        # But we can track them for OpenAI compatibility
        stop_sequences = context.openai_request.get("stop") if context.openai_request else None

        if stop_sequences:
            # Convert to list if string
            if isinstance(stop_sequences, str):
                stop_sequences = [stop_sequences]

            if isinstance(stop_sequences, list):
                context.metadata["stop_sequences"] = stop_sequences
                logger.debug(f"Stop sequences configured: {stop_sequences}")

        return context


class StreamingResponseProcessor(BaseProcessor):
    """
    Create a StreamingResponse from the event stream.

    This is typically the last processor for streaming requests.
    """

    def __init__(self):
        self.serializer = EventSerializer()

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Serialize event stream and create StreamingResponse.

        Requires:
            - event_stream in context
            - messages_request with stream=true

        Produces:
            - response in context (StreamingResponse)
        """
        if context.response:
            logger.debug("Skipping StreamingResponseProcessor - response already set")
            return context

        if not context.event_stream:
            logger.warning("Skipping StreamingResponseProcessor - no event_stream")
            return context

        # Check if this is a streaming request
        if not context.messages_request or not context.messages_request.stream:
            logger.debug("Skipping StreamingResponseProcessor - non-streaming request")
            return context

        logger.info("Creating streaming response")

        sse_stream = self.serializer.serialize_stream(context.event_stream)

        context.response = StreamingResponse(
            sse_stream,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

        context.metadata["response_ready"] = True
        return context


class NonStreamingResponseProcessor(BaseProcessor):
    """
    Build a non-streaming JSON response from collected message.

    This runs for non-streaming requests after the stream is consumed.
    """

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Build JSON response from collected message.

        Requires:
            - collected_message in context
            - Not a streaming request

        Produces:
            - response in context (JSONResponse)
        """
        if context.response:
            logger.debug("Skipping NonStreamingResponseProcessor - response already set")
            return context

        if context.messages_request and context.messages_request.stream:
            logger.debug("Skipping NonStreamingResponseProcessor - streaming request")
            return context

        if not context.collected_message:
            logger.warning("Skipping NonStreamingResponseProcessor - no collected message")
            return context

        logger.info("Building non-streaming response")

        response_data = {
            "id": context.collected_message.get("id", context.request_id),
            "object": "chat.completion",
            "created": int(context.created_at),
            "model": context.model or "claude",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": context.collected_message.get("content"),
                    },
                    "finish_reason": context.finish_reason or "stop",
                }
            ],
        }

        if context.tool_calls:
            response_data["choices"][0]["message"]["tool_calls"] = context.tool_calls

        if context.usage:
            response_data["usage"] = context.usage

        context.response = JSONResponse(
            content=response_data,
            headers={
                "Content-Type": "application/json",
                "Cache-Control": "no-cache",
            },
        )

        return context