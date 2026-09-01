"""Base classes for the request processing pipeline."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional, Any, Dict
from fastapi import Request
from fastapi.responses import StreamingResponse, JSONResponse
from datetime import datetime
import uuid


@dataclass
class BaseContext:
    """Base context passed between processors in the pipeline."""

    original_request: Request
    response: Optional[StreamingResponse | JSONResponse] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    request_id: str = ""

    def __post_init__(self):
        if not self.request_id:
            self.request_id = str(uuid.uuid4())


class BaseProcessor(ABC):
    """Base class for all request processors."""

    @property
    def name(self) -> str:
        """Get the processor name."""
        return self.__class__.__name__

    @abstractmethod
    async def process(self, context: BaseContext) -> BaseContext:
        """
        Process the request context.

        Args:
            context: The processing context

        Returns:
            Updated context.
        """
        pass


class ProcessingPipeline(BaseProcessor):
    """
    Main pipeline that processes requests through a chain of processors.

    Example:
        pipeline = ProcessingPipeline([
            AuthProcessor(),
            FormatProcessor(),
            SessionProcessor(),
            ...
        ])
        context = await pipeline.process(context)
    """

    def __init__(self, processors: list[BaseProcessor]):
        self.processors = processors
        if len(self.processors) == 0:
            raise ValueError("Pipeline must have at least one processor")

    async def process(self, context: BaseContext) -> BaseContext:
        """Process a request through the pipeline."""
        for i, processor in enumerate(self.processors):
            skip = context.metadata.get("skip_processors", [])
            if processor.name in skip:
                continue

            context = await processor.process(context)

            if context.metadata.get("stop_pipeline", False):
                break

        return context