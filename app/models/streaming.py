"""Streaming event models for Claude SSE format."""

from typing import Optional, Union, Dict, Any, Literal
from pydantic import BaseModel, RootModel, Field


class BaseEvent(BaseModel):
    """Base event type."""
    model_config = {"extra": "allow"}
    type: str


# Delta types
class TextDelta(BaseModel):
    """Text content delta."""
    model_config = {"extra": "allow"}
    type: Literal["text_delta"]
    text: str


class InputJsonDelta(BaseModel):
    """Input JSON delta for tool calls."""
    model_config = {"extra": "allow"}
    type: Literal["input_json_delta"]
    partial_json: str


class ThinkingDelta(BaseModel):
    """Thinking delta."""
    model_config = {"extra": "allow"}
    type: Literal["thinking_delta"]
    thinking: str


Delta = Union[TextDelta, InputJsonDelta, ThinkingDelta]


class ContentBlockDeltaEvent(BaseEvent):
    """Content block delta event."""
    type: Literal["content_block_delta"]
    index: int
    delta: Delta


class MessageStartEvent(BaseEvent):
    """Message start event."""
    type: Literal["message_start"]
    message: Dict[str, Any]


class ContentBlockStartEvent(BaseEvent):
    """Content block start event."""
    type: Literal["content_block_start"]
    index: int
    content_block: Dict[str, Any]


class ContentBlockStopEvent(BaseEvent):
    """Content block stop event."""
    type: Literal["content_block_stop"]
    index: int


class MessageDeltaData(BaseModel):
    """Message delta data."""
    model_config = {"extra": "allow"}
    stop_reason: Optional[
        Literal["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"]
    ] = None
    stop_sequence: Optional[str] = None


class MessageDeltaEvent(BaseEvent):
    """Message delta event."""
    type: Literal["message_delta"]
    delta: MessageDeltaData
    usage: Optional[Dict[str, int]] = None


class MessageStopEvent(BaseEvent):
    """Message stop event."""
    type: Literal["message_stop"]


class PingEvent(BaseEvent):
    """Ping event."""
    type: Literal["ping"]


class ErrorInfo(BaseModel):
    """Error information."""
    model_config = {"extra": "allow"}
    type: str
    message: str


class ErrorEvent(BaseEvent):
    """Error event."""
    type: Literal["error"]
    error: ErrorInfo


class UnknownEvent(BaseEvent):
    """Unknown event type."""
    type: str
    data: Dict[str, Any] = Field(default_factory=dict)


class StreamingEvent(RootModel):
    """
    A streaming event from Claude.

    Can be any of the event types defined above.
    """
    root: Union[
        MessageStartEvent,
        ContentBlockStartEvent,
        ContentBlockDeltaEvent,
        ContentBlockStopEvent,
        MessageDeltaEvent,
        MessageStopEvent,
        PingEvent,
        ErrorEvent,
        UnknownEvent,
    ]

    def __getattr__(self, name):
        """
        Access attributes of the root event.

        This allows `event.type` instead of `event.root.type`.
        """
        try:
            return getattr(self.root, name)
        except AttributeError:
            # Provide defaults for common attributes
            if name == "event_type":
                if isinstance(self.root, BaseModel):
                    return self.root.type
                if isinstance(self.root, dict):
                    return self.root.get("type", "unknown")
                return "unknown"
            raise

    def __getitem__(self, key):
        """Dict-style access for compatibility."""
        return self.root[key]