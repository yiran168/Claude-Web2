"""OpenAI-compatible request/response models."""

from typing import Optional, List, Union, Dict, Any, Literal
from pydantic import BaseModel, Field, model_validator


# ==================== Chat Completion Models ====================


class ChatCompletionMessageToolCall(BaseModel):
    """Tool call in a message."""
    id: str
    type: Literal["function"] = "function"
    function: "FunctionObject"


class ChatCompletionMessageToolCallChunk(BaseModel):
    """Tool call chunk in streaming response."""
    index: int
    id: Optional[str] = None
    type: Optional[str] = None
    function: "FunctionObjectPartial"


class FunctionObject(BaseModel):
    """Function object for tool calls."""
    name: str
    arguments: str


class FunctionObjectPartial(BaseModel):
    """Partial function object for streaming."""
    name: Optional[str] = None
    arguments: Optional[str] = None


class ChatCompletionTextObject(BaseModel):
    """Text content in a message."""
    type: Literal["text"] = "text"
    text: str


class ChatCompletionImageObject(BaseModel):
    """Image content in a message."""
    type: Literal["image_url"] = "image_url"
    image_url: "ImageURLObject"


class ImageURLObject(BaseModel):
    """Image URL object."""
    url: str
    detail: Optional[Literal["low", "high", "auto"]] = "auto"


class ChatCompletionToolObject(BaseModel):
    """Tool definition for tool calling."""
    type: Literal["function"] = "function"
    function: "FunctionDefinition"


class FunctionDefinition(BaseModel):
    """Function definition."""
    description: Optional[str] = None
    name: str
    parameters: Dict[str, Any]
    strict: Optional[bool] = None


class ChatCompletionToolMessageParam(BaseModel):
    """Tool message."""
    role: Literal["tool"]
    content: Union[str, List[Union[ChatCompletionTextObject, ChatCompletionImageObject]]]
    tool_call_id: str


class ChatCompletionMessageParam(BaseModel):
    """A message in a chat completion request."""
    role: Literal["user", "assistant", "system", "tool"]
    content: Optional[Union[
        str,
        List[Union[ChatCompletionTextObject, ChatCompletionImageObject]],
    ]] = None
    name: Optional[str] = None
    tool_calls: Optional[List[ChatCompletionMessageToolCall]] = None
    tool_call_id: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    """Request model for /v1/chat/completions."""

    model: str
    messages: List[ChatCompletionMessageParam]
    temperature: Optional[float] = Field(default=None, ge=0, le=2)
    top_p: Optional[float] = Field(default=None, ge=0, le=1)
    n: Optional[int] = Field(default=1, ge=1)
    stream: Optional[bool] = False
    stop: Optional[Union[str, List[str]]] = None
    max_tokens: Optional[int] = None
    presence_penalty: Optional[float] = Field(default=0, ge=-2, le=2)
    frequency_penalty: Optional[float] = Field(default=0, ge=-2, le=2)
    logit_bias: Optional[Dict[str, float]] = None
    user: Optional[str] = None
    tools: Optional[List[ChatCompletionToolObject]] = None
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None
    logprobs: Optional[bool] = None
    top_logprobs: Optional[int] = None
    stream_options: Optional[Dict[str, Any]] = None


class Usage(BaseModel):
    """Usage statistics."""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class Choices(BaseModel):
    """Choice in a completion response."""
    index: int
    message: "ChatCompletionMessage"
    finish_reason: Optional[str] = None


class ChatCompletionMessage(BaseModel):
    """Message in a completion response."""
    role: str = "assistant"
    content: Optional[str] = None
    tool_calls: Optional[List[ChatCompletionMessageToolCall]] = None


class ChatCompletionResponse(BaseModel):
    """Response model for /v1/chat/completions."""

    id: str
    object: Literal["chat.completion"] = "chat.completion"
    created: int
    model: str
    choices: List[Choices]
    usage: Optional[Usage] = None


class ChatCompletionChunkDelta(BaseModel):
    """Delta in a streaming chunk."""
    content: Optional[str] = None
    role: Optional[str] = None
    tool_calls: Optional[List[ChatCompletionMessageToolCallChunk]] = None


class ChatCompletionChunkChoice(BaseModel):
    """Choice in a streaming chunk."""
    index: int
    delta: ChatCompletionChunkDelta
    finish_reason: Optional[str] = None


class ChatCompletionChunk(BaseModel):
    """A streaming chunk."""
    id: str
    object: Literal["chat.completion.chunk"] = "chat.completion.chunk"
    created: int
    model: str
    choices: List[ChatCompletionChunkChoice]
    system_fingerprint: Optional[str] = None