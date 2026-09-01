"""SSE stream parsing processor."""

from typing import AsyncIterator
from loguru import logger

from app.processors.base import BaseProcessor
from app.processors.context import ClaudeAIContext
from app.services.event_processing.event_parser import EventParser
from app.models.streaming import StreamingEvent


class EventParsingProcessor(BaseProcessor):
    """
    Parse the original SSE stream into typed StreamingEvent objects.

    This runs after ClaudeWebProcessor which produces original_stream.
    """

    def __init__(self):
        self.parser = EventParser()

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Parse the SSE stream.

        Requires:
            - original_stream in context

        Produces:
            - event_stream in context (AsyncIterator[StreamingEvent])
        """
        if context.event_stream:
            logger.debug("Skipping EventParsingProcessor - already has event_stream")
            return context

        if not context.original_stream:
            logger.warning("Skipping EventParsingProcessor - no original_stream")
            return context

        logger.debug("Parsing SSE stream into events")

        raw_stream = context.original_stream
        context.event_stream = self.parser.parse_stream(raw_stream)

        return context