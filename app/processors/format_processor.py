"""Format conversion processor (OpenAI ↔ Claude)."""

from typing import Dict, Any, List, Optional
from loguru import logger

from app.processors.base import BaseProcessor
from app.processors.context import ClaudeAIContext
from app.models.openai import ChatCompletionMessageParam
from app.models.internal import ClaudeWebRequest, Attachment
from app.utils.messages import (
    format_prompt,
    normalize_model_name,
    format_tool_call_native,
    is_thinking_mode,
    get_default_max_tokens,
    estimate_token_count,
)
import json


class FormatProcessor(BaseProcessor):
    """
    Convert OpenAI API requests to Claude Web API format.

    This processor:
    1. Converts OpenAI messages to Claude prompt format
    2. Maps model names
    3. Converts tools to Claude format
    4. Extracts images and files for upload
    5. Handles tool call results
    """

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Convert openai_request to claude_web_request.

        Requires:
            - openai_request in context
            - account in context (for model mapping)

        Produces:
            - claude_web_request in context
            - model in context
        """
        if context.claude_web_request:
            logger.debug("Skipping FormatProcessor - already processed")
            return context

        if not context.openai_request:
            logger.warning("Skipping FormatProcessor - no openai_request")
            return context

        req = context.openai_request
        messages = req.get("messages", [])
        tools = req.get("tools")
        stream = req.get("stream", False)
        max_tokens = req.get("max_tokens")
        model = req.get("model", "")

        # Normalize model name
        model = normalize_model_name(model)
        context.model = model

        # Handle thinking mode
        paprika_mode = None
        if is_thinking_mode(model) and context.account and context.account.is_pro:
            paprika_mode = "extended"

        # Extract images from messages
        images = await self._extract_images(messages)

        # Format messages as Claude prompt
        system_prompt = req.get("system")
        prompt = format_prompt(messages, tools, system_prompt)

        # Format tools for Claude
        tools_formatted = tools or []

        # Build the request
        context.claude_web_request = ClaudeWebRequest(
            attachments=[Attachment.from_text(prompt)],
            files=[],
            model=model,
            rendering_mode="messages",
            prompt="",
            max_tokens_to_sample=max_tokens or get_default_max_tokens(model),
            timezone="UTC",
            tools=tools_formatted,
        )

        # Store metadata for session processor
        context.metadata["paprika_mode"] = paprika_mode
        context.metadata["images"] = images
        context.metadata["stream"] = stream
        context.metadata["thinking"] = req.get("thinking")

        logger.debug(
            f"Formatted request: model={model}, "
            f"messages={len(messages)}, "
            f"tools={len(tools_formatted) if tools_formatted else 0}, "
            f"images={len(images)}, "
            f"stream={stream}"
        )

        return context

    async def _extract_images(self, messages: List[Dict]) -> List[Dict[str, Any]]:
        """Extract image data from messages, downloading external URLs."""
        images = []

        for msg in messages:
            content = msg.get("content")
            if not isinstance(content, list):
                continue

            for block in content:
                if isinstance(block, dict) and block.get("type") == "image_url":
                    image_url_obj = block.get("image_url", {})
                    url = image_url_obj.get("url", "")
                    detail = image_url_obj.get("detail", "auto")

                    if url.startswith("data:"):
                        # Base64 image
                        images.append({
                            "data": url,
                            "detail": detail,
                        })
                    else:
                        # External URL - download and convert to base64
                        base64_data = await self._download_image(url)
                        if base64_data:
                            images.append({
                                "data": base64_data,
                                "detail": detail,
                            })
                        else:
                            logger.warning(f"Failed to download image from {url}")

        return images

    async def _download_image(self, url: str) -> Optional[str]:
        """Download image from URL and return as base64 data URL."""
        try:
            from app.core.http_client import get_client
            import base64
            
            async with get_client(timeout=30.0, follow_redirects=True) as client:
                resp = await client.get(url)
                if resp.status_code == 200:
                    content_type = resp.headers.get("content-type", "image/png")
                    base64_content = base64.b64encode(resp.content).decode("utf-8")
                    return f"data:{content_type};base64,{base64_content}"
        except Exception as e:
            logger.error(f"Error downloading image from {url}: {e}")
        return None


class ToolCallProcessor(BaseProcessor):
    """
    Process tool call results from the user.

    This processor:
    1. Detects tool result messages in the request
    2. Resumes the previous session for tool call round-trip
    3. Sends tool results to continue the conversation
    """

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Check for tool result messages and handle session resumption.

        Requires:
            - openai_request in context
            - session_id in metadata (from previous request)

        Produces:
            - original_stream if resuming a conversation
        """
        if not context.openai_request:
            return context

        messages: List[Dict] = context.openai_request.get("messages", [])
        if not messages:
            return context

        # Check if last message is a tool result from an assistant
        last_msg = messages[-1]

        # Look for tool result messages
        tool_results = []
        for msg in messages:
            if msg.get("role") == "tool":
                tool_results.append(msg)

        if not tool_results:
            return context

        # Check for pending tool calls
        session_id = context.metadata.get("session_id")
        if not session_id:
            # No session to resume - continue with normal processing
            return context

        from app.services.session_manager import session_manager
        from app.models.streaming import StreamingEvent
        from app.services.event_processing.event_serializer import EventSerializer
        from app.models.streaming import MessageStartEvent

        session = await session_manager.get_session(session_id)
        if not session:
            return context

        # Check if we have pending tool calls
        from app.services.tool_call_manager import tool_call_manager
        pending_calls = tool_call_manager.get_pending_for_session(session_id)

        if not pending_calls:
            return context

        # Send tool results to Claude
        for tool_msg in tool_results:
            tool_use_id = tool_msg.get("tool_call_id")
            if tool_use_id in pending_calls:
                result_content = tool_msg.get("content", "")
                # Keep content as-is - the client will handle formatting it
                # as proper content blocks [{"type": "text", "text": "..."}]
                # This matches clove's approach of passing structured content

                tool_result_payload = {
                    "tool_use_id": tool_use_id,
                    "content": result_content,
                    "is_error": False,
                }

                await session.send_tool_result(tool_result_payload)
                tool_call_manager.complete_tool_call(tool_use_id)

        # Resume from existing stream
        if session.sse_stream:
            context.original_stream = session.sse_stream
            context.claude_session = session
            context.metadata["skip_processors"] = ["AuthProcessor", "FormatProcessor"]

        return context