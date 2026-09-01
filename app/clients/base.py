"""Base client interface for Claude backends."""

from abc import ABC, abstractmethod
from typing import Optional, Dict, Any, AsyncIterator, List


class BaseClaudeClient(ABC):
    """
    Abstract base class for Claude clients.

    This allows pluggable backends:
    - ClaudeWebClient: Claude.ai web scraping
    - ClaudeAPIClient: Native Anthropic API
    - ClaudeCLI: Claude CLI
    """

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the client (fetch org UUID, etc.)."""
        pass

    @abstractmethod
    async def create_conversation(
        self, model: Optional[str] = None
    ) -> Optional[str]:
        """Create a new conversation. Returns conversation UUID."""
        pass

    @abstractmethod
    async def send_message(
        self,
        conv_uuid: str,
        prompt: str,
        model: Optional[str] = None,
        stream: bool = True,
        max_tokens: int = 4096,
        attachments: Optional[List[Dict]] = None,
        files: Optional[List[str]] = None,
        tools: Optional[List[Dict]] = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """Send a message and stream SSE response."""
        pass

    @abstractmethod
    async def delete_conversation(self, conv_uuid: str) -> bool:
        """Delete a conversation."""
        pass

    @abstractmethod
    async def upload_file(
        self, file_data: bytes, filename: str, content_type: str
    ) -> Optional[str]:
        """Upload a file. Returns file UUID."""
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """Clean up client resources."""
        pass


class ClaudeAPIClient(BaseClaudeClient):
    """
    Native Anthropic API client.

    Uses the official API endpoint (api.anthropic.com).
    Requires a valid ANTHROPIC_API_KEY.
    """

    def __init__(self, api_key: str, base_url: str = "https://api.anthropic.com"):
        self.api_key = api_key
        self.base_url = base_url
        self._client = None

    async def initialize(self) -> None:
        """Initialize API client."""
        # No initialization needed for native API
        pass

    async def create_conversation(self, model: Optional[str] = None) -> Optional[str]:
        """Conversations are implicit in the API, return a session ID."""
        import uuid as uuid_lib
        return str(uuid_lib.uuid4())

    async def send_message(
        self,
        conv_uuid: str,
        prompt: str,
        model: Optional[str] = None,
        stream: bool = True,
        max_tokens: int = 4096,
        attachments: Optional[List[Dict]] = None,
        files: Optional[List[str]] = None,
        tools: Optional[List[Dict]] = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """Send a message via Anthropic API."""
        import json
        from loguru import logger

        if not self._client:
            from app.core.http_client import get_client
            import httpx
            self._client = httpx.AsyncClient(
                timeout=60.0,
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
            )

        url = f"{self.base_url}/v1/messages"

        payload = {
            "model": model or "claude-3-sonnet-20240229",
            "max_tokens": max_tokens,
            "messages": [
                {"role": "user", "content": prompt}
            ],
        }

        if tools:
            payload["tools"] = tools

        if stream:
            payload["stream"] = True

        # Use pre-configured client headers
        headers = {}

        response = await self._client.request(
            "POST",
            url,
            json=payload,
            headers=headers,
            stream=stream,
        )

        if response.status_code != 200:
            error_data = await response.json()
            error_msg = error_data.get("error", {}).get("message", "Unknown error")
            logger.error(f"API error: {response.status_code} - {error_msg}")

            error_event = {
                "type": "error",
                "error": {
                    "type": "api_error",
                    "message": error_msg,
                    "status": response.status_code,
                }
            }
            yield f"data: {json.dumps(error_event)}\n\n"
            return

        if stream:
            async for chunk in response.aiter_text():
                yield chunk
        else:
            # Non-streaming: convert to SSE-like format for consistency
            data = await response.json()
            content_blocks = data.get("content", [])

            # Emit message_start
            message_start = {
                "type": "message_start",
                "message": {
                    "id": data.get("id"),
                    "model": data.get("model"),
                }
            }
            yield f"data: {json.dumps(message_start)}\n\n"

            # Emit content blocks
            for block in content_blocks:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        if text:
                            content_event = {
                                "type": "content_block_delta",
                                "index": 0,
                                "delta": {"type": "text_delta", "text": text}
                            }
                            yield f"data: {json.dumps(content_event)}\n\n"

            # Emit message_stop
            yield f"data: {json.dumps({'type': 'message_stop'})}\n\n"

    async def delete_conversation(self, conv_uuid: str) -> bool:
        """No-op for API mode (stateless)."""
        return True

    async def upload_file(
        self, file_data: bytes, filename: str, content_type: str
    ) -> Optional[str]:
        """Upload file via API (not supported in basic version)."""
        import uuid as uuid_lib
        # In a full implementation, this would use the files API
        return str(uuid_lib.uuid4())

    async def cleanup(self) -> None:
        """Clean up client."""
        if self._client:
            await self._client.aclose()
            self._client = None