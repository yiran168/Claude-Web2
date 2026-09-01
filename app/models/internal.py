"""Internal models for request processing pipeline."""

from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
from dataclasses import dataclass
from datetime import datetime


class Attachment(BaseModel):
    """File attachment for Claude request."""
    extracted_content: str
    file_name: str
    file_type: str
    file_size: int

    @classmethod
    def from_text(cls, content: str) -> "Attachment":
        return cls(
            extracted_content=content,
            file_name="paste.txt",
            file_type="txt",
            file_size=len(content),
        )


class ClaudeWebRequest(BaseModel):
    """Internal request model for Claude web API."""
    max_tokens_to_sample: int
    attachments: List[Attachment]
    files: List[str] = Field(default_factory=list)
    model: Optional[str] = None
    rendering_mode: str = "messages"
    prompt: str = ""
    timezone: str = "UTC"
    tools: List[Dict[str, Any]] = Field(default_factory=list)
    parent_message_uuid: str = "00000000-0000-4000-8000-000000000000"
    sync_sources: List[Any] = Field(default_factory=list)
    personalized_styles: List[Dict[str, Any]] = Field(default_factory=list)
    include_conversation_preferences: bool = True
    metadata: Dict[str, Any] = Field(default_factory=dict)
    model_config = {"extra": "allow"}


class StreamingEvent(BaseModel):
    """A parsed SSE event from Claude."""
    event_type: str
    data: Dict[str, Any]


@dataclass
class RequestContext:
    """Context for a single API request."""
    request_id: str
    model: str
    messages: List[Dict[str, Any]]
    stream: bool
    tools: Optional[List[Dict[str, Any]]]
    params: Dict[str, Any]
    created_at: datetime = None

    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.utcnow()


@dataclass
class AccountStatus:
    """Status of a Claude account."""
    is_valid: bool = True
    is_rate_limited: bool = False
    rate_limit_reset: Optional[datetime] = None
    last_used: Optional[datetime] = None
    error_count: int = 0
    capabilities: List[str] = None

    def __post_init__(self):
        if self.capabilities is None:
            self.capabilities = []


@dataclass
class AccountInfo:
    """Information about a Claude account."""
    identifier: str
    display_name: str
    status: AccountStatus
    auth_type: str  # "session_key", "cookie", or "oauth"
    organization_uuid: Optional[str] = None
    capabilities: List[str] = None

    def __post_init__(self):
        if self.capabilities is None:
            self.capabilities = []