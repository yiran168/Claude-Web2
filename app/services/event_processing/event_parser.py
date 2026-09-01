"""SSE event parsing from Claude streams."""

from typing import AsyncIterator, Optional, Dict, Any
import json

from loguru import logger

try:
    from pydantic import ValidationError
except ImportError:
    ValidationError = None

from app.models.streaming import StreamingEvent, UnknownEvent
from app.services.sse import parse_sse_stream, parse_sse_event_data


class EventParser:
    """
    Parse raw SSE text stream from Claude into StreamingEvent objects.

    Handles the Claude AI web API's SSE format, which differs from
    the native Anthropic API format.
    """

    def __init__(self, skip_unknown_events: bool = True):
        self.skip_unknown_events = skip_unknown_events
        self._buffer = ""

    async def parse_stream(
        self, raw_stream: AsyncIterator[str]
    ) -> AsyncIterator[Any]:
        """
        Parse an SSE stream and yield event objects.

        Args:
            raw_stream: AsyncIterator yielding string chunks from the SSE stream

        Yields:
            StreamingEvent objects (or dicts) parsed from the stream
        """
        async for message in parse_sse_stream(raw_stream):
            if not message.data:
                continue

            event = self._create_event(message.event, message.data)
            if event:
                logger.debug(f"Parsed event: type={getattr(event, 'event_type', None)}")
                yield event

    def _create_event(self, event_type: Optional[str], data: str) -> Optional[StreamingEvent]:
        """
        Create a StreamingEvent from an SSE message.

        Args:
            event_type: The SSE event type
            data: The raw data string (JSON)

        Returns:
            StreamingEvent object or None if parsing fails
        """
        parsed_data = parse_sse_event_data(data)
        if parsed_data is None:
            return None

        # If we have an explicit event type, use it
        if event_type:
            event_type = event_type
        else:
            # Try to get type from data
            if isinstance(parsed_data, dict):
                event_type = parsed_data.get("type", "unknown")

        try:
            # Use RootModel pattern: StreamingEvent(root=data)
            # The pydantic RootModel will validate and pick the right event type
            return StreamingEvent(root=parsed_data)
        except Exception as e:
            if ValidationError is not None and isinstance(e, ValidationError):
                logger.debug(f"ValidationError parsing event: {e}")
            else:
                logger.debug(f"Failed to create StreamingEvent: {e}")

            # Fallback: create an UnknownEvent for compatibility
            if self.skip_unknown_events:
                return None
            return StreamingEvent(root=UnknownEvent(type=event_type, data=parsed_data))