"""Claude AI processing context and pipeline."""

from dataclasses import dataclass, field
from typing import Optional, Any, AsyncIterator, Dict, List
from fastapi import Request
from fastapi.responses import StreamingResponse, JSONResponse

from app.processors.base import BaseContext
from app.models.claude import ClaudeMessageRequest
from app.models.internal import ClaudeWebRequest, RequestContext


@dataclass
class ClaudeAIContext(BaseContext):
    """
    Context for Claude API request processing.

    Carries data through the processing pipeline:
    - Original OpenAI request
    - Converted Claude request
    - Account/session info
    - Stream references
    - Response
    """

    # Request data
    openai_request: Optional[Dict[str, Any]] = None
    messages_request: Optional[ClaudeMessageRequest] = None
    claude_web_request: Optional[ClaudeWebRequest] = None
    request_context: Optional[RequestContext] = None

    # Backend and client info
    account: Optional[Any] = None
    claude_client: Optional[Any] = None
    backend_type: str = "web"  # "web", "api", or "cli"

    # Streaming
    original_stream: Optional[AsyncIterator[str]] = None
    event_stream: Optional[AsyncIterator[Any]] = None

    # Results
    collected_message: Optional[Dict[str, Any]] = None
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    finish_reason: Optional[str] = "stop"
    usage: Optional[Dict[str, int]] = None
    model: Optional[str] = None
    created_at: float = 0.0

    def __post_init__(self):
        from datetime import datetime
        if not self.created_at:
            self.created_at = datetime.utcnow().timestamp()
        if not self.request_id:
            self.request_id = f"chatcmpl-{__import__('uuid').uuid4().hex[:12]}"