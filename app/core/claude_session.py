"""Session model for Claude web sessions."""

from typing import Optional, List, Dict, Any, AsyncIterator
from datetime import datetime, timezone
from loguru import logger

from app.core.account import Account
from app.config import settings


class ClaudeWebSession:
    """
    Represents a Claude web session with conversation state.

    Sessions are stored and managed by SessionManager.
    They hold the conversation UUID and keep the client alive
    for tool call round-trips.
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.last_activity: datetime = datetime.now(timezone.utc)
        self.conv_uuid: Optional[str] = None
        self.client: Optional[Any] = None  # ClaudeWebClient or ClaudeAPIClient
        self.account: Optional[Any] = None
        self.initialized: bool = False
        self.sse_stream: Optional[AsyncIterator[str]] = None
        self.paprika_mode: Optional[str] = None

    async def set_client(self, client) -> None:
        """Set the Claude client for this session."""
        self.client = client
        self.account = getattr(client, 'account', None)

    async def initialize(self) -> None:
        """Initialize the session by creating a conversation."""
        if not self.client:
            raise ValueError("Client not set for session")

        model = settings.get("default_model", "claude-3-5-sonnet-20241022")

        # Create conversation
        self.conv_uuid = await self.client.create_conversation(model=model)
        if not self.conv_uuid:
            from app.core.exceptions import AppError
            raise AppError("Failed to create conversation", status_code=502)

        self.initialized = True
        logger.debug(f"Session {self.session_id} initialized with conv {self.conv_uuid}")

    async def send_message(self, request_data: Dict[str, Any]) -> AsyncIterator[str]:
        """
        Send a message to Claude.ai and return the SSE stream.

        Args:
            request_data: The formatted request data

        Returns:
            Async iterator of SSE data chunks
        """
        self.update_activity()

        if not self.conv_uuid:
            await self.initialize()

        # Extract parameters
        model = request_data.get("model")
        prompt = request_data.get("prompt", "")
        max_tokens = request_data.get("max_tokens_to_sample", 4096)
        attachments = request_data.get("attachments", [])
        files = request_data.get("files", [])
        tools = request_data.get("tools", [])
        stream = request_data.get("stream", True)

        # Build prompt from attachments (text content)
        if attachments:
            for att in attachments:
                if isinstance(att, dict) and "extracted_content" in att:
                    prompt = att["extracted_content"]
                    break

        # Send message via client
        response = await self.client.send_message(
            conv_uuid=self.conv_uuid,
            prompt=prompt,
            model=model,
            stream=True,  # Always stream, convert later if needed
            max_tokens=max_tokens,
            attachments=attachments,
            files=files,
            tools=tools,
        )

        self.sse_stream = response
        logger.debug(f"Message sent for session {self.session_id}")

        return response

    async def send_tool_result(self, tool_result: Dict[str, Any]) -> None:
        """
        Send a tool result to continue a paused conversation.

        Args:
            tool_result: Tool result data with keys:
                - tool_use_id: ID of the tool use to respond to
                - content: Tool result content (string or list of content blocks)
                - is_error: Whether this is an error result
        """
        if not self.conv_uuid or not self.client:
            raise ValueError("Session not properly initialized")

        self.update_activity()

        # Call the client's send_tool_result which uses Claude's /tool_result endpoint
        # and returns the SSE stream continuation
        stream = self.client.send_tool_result(
            conv_uuid=self.conv_uuid,
            tool_use_id=tool_result.get("tool_use_id", ""),
            tool_name=tool_result.get("tool_name", ""),
            tool_result=tool_result.get("content", ""),
        )

        # Set the SSE stream for the caller to consume
        self.sse_stream = stream

        logger.debug(f"Sent tool result for {tool_result.get('tool_use_id', 'unknown')}")

    async def upload_file(
        self, file_data: bytes, filename: str, content_type: str
    ) -> str:
        """Upload a file to Claude.ai."""
        if not self.client:
            raise ValueError("Client not set")

        file_id = await self.client.upload_file(file_data, filename, content_type)
        if file_id:
            return file_id
        raise RuntimeError(f"Failed to upload {filename}")

    async def cleanup(self) -> None:
        """Clean up session resources."""
        logger.debug(f"Cleaning up session {self.session_id}")

        # Delete conversation if client supports it
        if self.conv_uuid and self.client:
            try:
                await self.client.delete_conversation(self.conv_uuid)
            except Exception as e:
                logger.debug(f"Failed to delete conversation: {e}")

        # Clean up client
        if self.client:
            try:
                await self.client.cleanup()
            except Exception as e:
                logger.debug(f"Error cleaning up client: {e}")

        self.initialized = False

    def update_activity(self) -> None:
        """Update last activity timestamp."""
        self.last_activity = datetime.now(timezone.utc)

    def is_expired(self, timeout: int = 300) -> bool:
        """Check if session is expired based on timeout."""
        elapsed = (datetime.now(timezone.utc) - self.last_activity).total_seconds()
        return elapsed > timeout

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit - cleanup."""
        await self.cleanup()