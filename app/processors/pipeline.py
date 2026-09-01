"""Main processing pipeline for Claude requests."""

from typing import List, Optional
from loguru import logger

from app.processors.base import BaseProcessor, ProcessingPipeline
from app.processors.context import ClaudeAIContext

# Lazy load processor classes to avoid circular imports
from app.processors.auth_processor import AuthProcessor
from app.processors.format_processor import FormatProcessor, ToolCallProcessor
from app.processors.session_processor import SessionProcessor
from app.processors.claude_web_processor import ClaudeWebProcessor
from app.processors.event_parsing_processor import EventParsingProcessor
from app.processors.response_processor import (
    ModelInjectorProcessor,
    StopSequencesProcessor,
    MessageCollectorProcessor,
    StreamingResponseProcessor,
    NonStreamingResponseProcessor,
)
from app.processors.tool_call_processor import ToolCallEventProcessor


class ClaudeAIPipeline(ProcessingPipeline):
    """
    Processing pipeline for Claude API requests.

    Default processor chain:
    1. AuthProcessor - Resolve authentication and select account
    2. FormatProcessor - Convert OpenAI → Claude format
    3. ToolCallProcessor - Handle tool result messages
    4. SessionProcessor - Create/manage sessions
    5. ClaudeWebProcessor - Send request to Claude.ai
    6. EventParsingProcessor - Parse SSE stream
    7. ModelInjectorProcessor - Inject model name
    8. StopSequencesProcessor - Handle stop sequences
    9. ToolCallEventProcessor - Handle tool calls in stream
    10. MessageCollectorProcessor - Collect message (non-streaming)
    11. StreamingResponseProcessor - Create SSE response
    12. NonStreamingResponseProcessor - Create JSON response
    """

    def __init__(self, processors: Optional[List[BaseProcessor]] = None):
        if processors is None:
            processors = [
                AuthProcessor(),
                FormatProcessor(),
                ToolCallProcessor(),
                SessionProcessor(),
                ClaudeWebProcessor(),
                EventParsingProcessor(),
                ModelInjectorProcessor(),
                StopSequencesProcessor(),
                ToolCallEventProcessor(),
                MessageCollectorProcessor(),
                StreamingResponseProcessor(),
                NonStreamingResponseProcessor(),
            ]

        super().__init__(processors)

    async def process(
        self,
        context: ClaudeAIContext,
    ) -> ClaudeAIContext:
        """
        Process a Claude API request through the pipeline.

        Args:
            context: The processing context

        Returns:
            Updated context.

        Raises:
            Exception: If any processor fails or no response is generated
        """
        try:
            return await super().process(context)
        except Exception as e:
            logger.error(f"Pipeline processing failed: {e}")

            # Cleanup session on error
            if context.claude_session:
                from app.services.session_manager import session_manager
                await session_manager.remove_session(context.claude_session.session_id)

            raise


def _lazy_import(module_path: str, class_name: str) -> str:
    """Return a string identifier for lazy import."""
    return f"{module_path}.{class_name}"


def _import_module(path: str):
    """Import a module by dotted path."""
    import importlib
    return importlib.import_module(path)