"""SSE event parsing and serialization."""

import json
from typing import Optional, Dict, Any, AsyncGenerator
from dataclasses import dataclass
from loguru import logger


@dataclass
class SSEMessage:
    """A parsed SSE message."""
    event: Optional[str] = None
    data: Optional[str] = None


async def parse_sse_stream(raw_stream):
    """
    Parse a raw SSE stream into individual SSE messages.

    An SSE message consists of one or more lines with 'field: value' format,
    followed by a blank line (double newline).
    """

    buffer = ""

    async for chunk in raw_stream:
        # Normalize line endings
        chunk = chunk.replace('\r\n', '\n')
        buffer += chunk

        # Process complete messages (separated by double newline)
        while "\n\n" in buffer:
            message_text, buffer = buffer.split("\n\n", 1)
            message = parse_sse_message(message_text)
            if message.data:
                yield message

    # Flush remaining buffer
    if buffer.strip():
        message = parse_sse_message(buffer)
        if message.data:
            yield message


def parse_sse_message(message_text: str) -> SSEMessage:
    """Parse a single SSE message from text."""
    message = SSEMessage()

    for line in message_text.split("\n"):
        if not line or line.startswith(":"):
            # Skip empty lines and comments
            continue

        if ":" in line:
            field, value = line.split(":", 1)
            if value.startswith(" "):
                value = value[1:]
        else:
            field = line
            value = ""

        if field == "event":
            message.event = value
        elif field == "data":
            if message.data is None:
                message.data = value
            else:
                message.data += "\n" + value

    return message


def parse_sse_event_data(data: str) -> Optional[Dict[str, Any]]:
    """Parse JSON data from an SSE data field."""
    try:
        return json.loads(data)
    except json.JSONDecodeError as e:
        logger.debug(f"Failed to parse SSE data JSON: {e}")
        return None


def serialize_openai_sse_event(
    data: Dict[str, Any],
    event_type: Optional[str] = None,
) -> str:
    """
    Serialize a data payload as an OpenAI-compatible SSE event.

    Args:
        data: The event data payload
        event_type: Optional event type (e.g., 'error')

    Returns:
        Formatted SSE string
    """
    lines = []

    if event_type:
        lines.append(f"event: {event_type}")

    lines.append(f"data: {json.dumps(data, ensure_ascii=False)}")
    lines.append("")
    lines.append("")

    return "\n".join(lines)