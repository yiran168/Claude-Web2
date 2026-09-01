"""Claude API models and types."""

from typing import Optional, List, Union, Literal, Dict, Any
from pydantic import BaseModel, Field
from enum import Enum


class Role(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


class ImageType(str, Enum):
    JPEG = "image/jpeg"
    PNG = "image/png"
    WEBP = "image/webp"


# Image sources
class Base64ImageSource(BaseModel):
    type: Literal["base64"] = "base64"
    media_type: ImageType
    data: str


class URLImageSource(BaseModel):
    type: Literal["url"] = "url"
    url: str


class FileImageSource(BaseModel):
    type: Literal["file"] = "file"
    file_uuid: str


# Content types
class TextContent(BaseModel):
    type: Literal["text"] = "text"
    text: str
    model_config = {"extra": "allow"}


class ImageContent(BaseModel):
    type: Literal["image"] = "image"
    source: Base64ImageSource | URLImageSource | FileImageSource


# Tool content blocks
class ToolUseContent(BaseModel):
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: Dict[str, Any]


class ToolResultContent(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str | List[TextContent]
    is_error: Optional[bool] = False


class ThinkingContent(BaseModel):
    type: Literal["thinking"] = "thinking"
    thinking: str


class RedactedThinkingContent(BaseModel):
    type: Literal["redacted_thinking"] = "redacted_thinking"
    data: str


# Usage
class Usage(BaseModel):
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: Optional[int] = None
    cache_read_input_tokens: Optional[int] = None


class Message(BaseModel):
    """A message in Claude API format."""
    role: Literal["user", "assistant"]
    content: Union[str, List[Union[TextContent, ImageContent, ToolUseContent, ToolResultContent, ThinkingContent]]]
    model_config = {"extra": "allow"}


class ToolInputSchema(BaseModel):
    type: str = "object"
    properties: Dict[str, Any] = Field(default_factory=dict)
    required: List[str] = Field(default_factory=list)
    model_config = {"extra": "allow"}


class Tool(BaseModel):
    name: str
    description: Optional[str] = None
    input_schema: ToolInputSchema = Field(default_factory=ToolInputSchema)
    model_config = {"extra": "allow"}


class CacheControl(BaseModel):
    type: Literal["ephemeral"]


class Metadata(BaseModel):
    user_id: Optional[str] = None
    model_config = {"extra": "allow"}


class MessagesAPIRequest(BaseModel):
    """Request model for Claude Messages API."""
    model: str
    messages: List[Message]
    system: Optional[str] = None
    max_tokens: Optional[int] = 4096
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    stream: Optional[bool] = False
    stop_sequences: Optional[List[str]] = None
    tools: Optional[List[Tool]] = None
    thinking: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    model_config = {"extra": "allow"}

    def to_openai_format(self) -> Dict[str, Any]:
        """Convert to OpenAI chat completions format."""
        openai_msgs = []

        if self.system:
            openai_msgs.append({
                "role": "system",
                "content": self.system,
            })

        for msg in self.messages:
            msg_dict = {"role": msg.role}
            if isinstance(msg.content, str):
                msg_dict["content"] = msg.content
            else:
                content_parts = []
                for c in msg.content:
                    if isinstance(c, TextContent):
                        content_parts.append({"type": "text", "text": c.text})
                    elif isinstance(c, ToolUseContent):
                        content_parts.append({
                            "type": "tool_use",
                            "id": c.id,
                            "name": c.name,
                            "input": c.input,
                        })
                    elif isinstance(c, ToolResultContent):
                        content_str = c.content if isinstance(c.content, str) else \
                            "".join(item.text if hasattr(item, 'text') else str(item) for item in c.content)
                        msg_dict["content"] = content_str
                        msg_dict["role"] = "tool"
                        msg_dict["tool_call_id"] = c.tool_use_id
                if "content" not in msg_dict:
                    msg_dict["content"] = content_parts
            openai_msgs.append(msg_dict)

        result = {
            "model": self.model,
            "messages": openai_msgs,
            "stream": self.stream,
        }

        if self.max_tokens:
            result["max_tokens"] = self.max_tokens
        if self.temperature is not None:
            result["temperature"] = self.temperature
        if self.top_p is not None:
            result["top_p"] = self.top_p
        if self.stop_sequences:
            result["stop"] = self.stop_sequences
        if self.tools:
            result["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description or "",
                        "parameters": t.input_schema.model_dump(),
                    },
                }
                for t in self.tools
            ]
        if self.thinking == "enabled":
            result["metadata"] = {"thinking": True}

        return result
