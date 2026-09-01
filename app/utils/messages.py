"""Message formatting and conversion utilities."""

import re
import json
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime

from app.models.openai import (
    ChatCompletionMessageParam,
    ChatCompletionToolObject,
)


# Model name mapping (OpenAI-style to Claude AI-style)
MODEL_MAP = {
    # Claude 3.5
    "claude-3-5-sonnet": "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-latest": "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku": "claude-3-5-haiku-20241022",
    "claude-3-5-haiku-latest": "claude-3-5-haiku-20241022",
    
    # Claude 3
    "claude-3-opus": "claude-3-opus-20240229",
    "claude-3-opus-latest": "claude-3-opus-20240229",
    "claude-3-sonnet": "claude-3-sonnet-20240229",
    "claude-3-haiku": "claude-3-haiku-20240307",
    
    # Claude 4
    "claude-4-sonnet": "claude-sonnet-4-20250514",
    "claude-sonnet-4": "claude-sonnet-4-20250514",
    "claude-4-opus": "claude-opus-4-20250514",
    "claude-opus-4": "claude-opus-4-20250514",
    
    # Legacy
    "claude-2.1": "claude-2.1",
    "claude-2.0": "claude-2.0",
    
    # Aliases
    "claude": "claude-3-5-sonnet-20241022",
    "claude-latest": "claude-3-5-sonnet-20241022",
}


def normalize_model_name(model: str) -> str:
    """Normalize model name to Claude API format."""
    if not model:
        return "claude-3-5-sonnet-20241022"

    # Check for -think suffix (extended thinking)
    has_thinking = model.endswith("-think")
    base_model = model.removesuffix("-think") if has_thinking else model

    # Try direct mapping
    if base_model in MODEL_MAP:
        result = MODEL_MAP[base_model]
    else:
        result = base_model

    return result


def format_tools_for_claude(tools: List[Dict[str, Any]]) -> str:
    """
    Convert OpenAI-style tools to Claude's native XML tool format.

    Args:
        tools: List of tool definitions in OpenAI format

    Returns:
        Formatted tool description string for Claude prompt
    """
    if not tools:
        return ""

    lines = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue

        tool_def = tool.get("function", tool)
        name = tool_def.get("name", "unknown")
        desc = tool_def.get("description", "")
        params = tool_def.get("parameters", {})

        lines.append(f"  Tool: {name}")
        if desc:
            lines.append(f"    Description: {desc}")

        properties = params.get("properties", {})
        if properties:
            lines.append("    Parameters:")
            required = params.get("required", [])
            for pname, pinfo in properties.items():
                req = "required" if pname in required else "optional"
                ptype = pinfo.get("type", "string")
                pdesc = pinfo.get("description", "")
                line = f"      {pname} ({ptype}, {req})"
                if pdesc:
                    line += f": {pdesc}"
                lines.append(line)

    return "\n".join(lines)


def format_tool_call_native(name: str, args: Dict[str, Any]) -> str:
    """Convert tool name + args dict to Claude's native XML format.

    Uses \\x08antml: prefix for tool tags, which is the correct format
    for the Claude Web API to properly recognize tool calls.
    """
    parts = [f'<\x08antml:invoke name="{name}">']
    for k, v in args.items():
        parts.append(f'<\x08antml:parameter name="{k}">{v}</\x08antml:parameter>')
    parts.append("</\x08antml:invoke>")
    return "\n".join(parts)


def detect_language(messages: List[Dict[str, Any]]) -> str:
    """
    Detect if messages contain Cyrillic (to force Russian response).

    Args:
        messages: List of message dictionaries

    Returns:
        Language code (e.g., "en", "ru")
    """
    for msg in messages:
        if msg.get("role") in ("user", "system"):
            txt = msg.get("content", "") or ""
            if isinstance(txt, str):
                if any("\u0400" <= c <= "\u04FF" or "\u0500" <= c <= "\u052F" for c in txt):
                    return "ru"
    return "en"


def format_prompt(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    system_prompt: Optional[str] = None,
) -> str:
    """
    Format OpenAI-style messages into Claude's prompt format.

    Claude uses prefix style: "Human: ... Assistant: ..."
    System messages are prepended.
    Tool definitions are added before the first user message.

    Args:
        messages: List of OpenAI-style messages
        tools: Optional tool definitions
        system_prompt: Optional system prompt override

    Returns:
        Formatted prompt string for Claude
    """
    tool_block = format_tools_for_claude(tools) if tools else ""
    lang = detect_language(messages)
    # Language hint for Claude to match user's language
    lang_hints = {
        "ru": "\n\nIMPORTANT: Always respond in Russian.\n",
        "zh": "\n\nIMPORTANT: 始终用中文回答。\n",
        "ja": "\n\nIMPORTANT: 日本語で回答してください。\n",
        "ko": "\n\nIMPORTANT: 한국어로 답변하십시오。\n",
    }
    lang_hint = lang_hints.get(lang, "")

    parts = []
    added_tools = False

    # Add system prompt if provided
    if system_prompt:
        parts.append(f"\x08System: {system_prompt}{lang_hint}")
        if tool_block:
            parts.append(f"\n\nYou have access to the following tools. Use them by enclosing your tool calls in <\x08antml:function_calls> and </\x08antml:function_calls> XML tags:\n{tool_block}")
            added_tools = True

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content") or ""
        if isinstance(content, list):
            # Handle content blocks (images, etc.)
            text_parts = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
                    elif block.get("type") == "image_url":
                        # Images are handled separately via file upload
                        # Do NOT add placeholder text - let session processor handle attachments
                        pass
            content = "".join(text_parts)

        if role == "system":
            text = f"\x08System: {content}{lang_hint}"
            if tool_block and not added_tools:
                text += f"\n\nYou have access to the following tools. Use them by enclosing your tool calls in <\x08antml:function_calls> and </\x08antml:function_calls> XML tags:\n{tool_block}"
                added_tools = True
            parts.append(text)

        elif role == "user":
            # If there are tool calls in the previous assistant message, continue from there
            if not added_tools and tool_block and not any(p.startswith("\x08System:") for p in parts):
                # Add tools before first user message if no system message
                parts.insert(0, f"\x08System:{lang_hint} You have access to the following tools. Use them by enclosing your tool calls in <\x08antml:function_calls> and </\x08antml:function_calls> XML tags:\n{tool_block}")
                added_tools = True
            parts.append(f"\x08Human: {content}")

        elif role == "assistant":
            tc = msg.get("tool_calls")
            if tc:
                calls = []
                for t in tc:
                    fn = t.get("function", {}) if isinstance(t, dict) else {}
                    name = fn.get("name", "unknown")
                    try:
                        args = json.loads(fn.get("arguments", "{}"))
                    except (json.JSONDecodeError, TypeError):
                        args = {}
                    calls.append(format_tool_call_native(name, args))

                if content:
                    text = f"\x08Assistant: {content}\n<\x08antml:function_calls>\n"
                else:
                    text = f"\x08Assistant:\n<\x08antml:function_calls>\n"
                text += "\n".join(calls) + f"\n</\x08antml:function_calls>"
                parts.append(text)
            else:
                parts.append(f"\x08Assistant: {content}")

        elif role == "tool":
            name = msg.get("name", "")
            tid = msg.get("tool_call_id", "")
            label = f" (tool: {name})" if name else f" (id: {tid})" if tid else ""
            result_content = content[:500] if isinstance(content, str) else str(content)[:500]
            parts.append(f"\x08Human: [Tool result{label}]\n{result_content}")

    # Add tools before assistant if not yet added
    if tool_block and not added_tools:
        parts.insert(0, f"\x08System:{lang_hint} You have access to the following tools. Use them by enclosing your tool calls in <\x08antml:function_calls> and </\x08antml:function_calls> XML tags:\n{tool_block}")

    parts.append("\x08Assistant:")

    return "\n\n".join(parts)


def parse_tool_calls_from_text(text: str) -> Optional[List[Dict[str, Any]]]:
    """Parse Claude's tool call XML from text into OpenAI tool_calls list.

    Handles multiple formats:
    1. <antml:invoke name="X"><antml:parameter name="Y">Z</antml:parameter></antml:invoke>
       (with \\x08 backspace prefix for Claude Web API)
    2. <atml:invoke name="X">...<atml:parameter name="Y">Z</atml:parameter>...</atml:invoke>
    3. <invoke name="X"><parameter name="Y">Z</parameter></invoke>
    4. Simple format <invoke tool="X">\nARGS_JSON\n</invoke>

    Args:
        text: The response text containing tool calls

    Returns:
        List of tool call objects in OpenAI format, or None if no tool calls found
    """
    calls = []

    # Pattern: <\x08antml:invoke name="X"><\x08antml:parameter name="Y">Z</\x08antml:parameter></\x08antml:invoke>
    # Also support atml:invoke and plain invoke formats
    antml_invoke_re = re.compile(
        r'<(?:\x08antml:|atml:|)invoke\s+name="([^"]+)"[^>]*>(.*?)(?:</(?:\x08antml:|atml:|)invoke>|$)',
        re.DOTALL
    )
    param_re = re.compile(
        r'<(?:\x08antml:|atml:|)parameter\s+name="([^"]+)"[^>]*>(.*?)(?:</(?:\x08antml:|atml:|)parameter>|$)',
        re.DOTALL
    )

    for match in antml_invoke_re.finditer(text):
        name = match.group(1)
        params_body = match.group(2)
        args = {}

        for param_match in param_re.finditer(params_body):
            val = param_match.group(2).strip()
            if val:
                args[param_match.group(1)] = val

        calls.append({
            "id": f"call_{__import__('uuid').uuid4().hex[:12]}",
            "type": "function",
            "function": {
                "name": name,
                "arguments": json.dumps(args, ensure_ascii=False)
            }
        })

    if calls:
        return calls

    # Pattern 2: <invoke name="X"><parameter name="Y">Z</parameter></invoke>
    invoke_re = re.compile(
        r'<invoke\s+name="([^"]+)">(.*?)(?:</invoke>|$)',
        re.DOTALL
    )
    param_re = re.compile(
        r'<parameter\s+name="([^"]+)">(.*?)(?:</parameter>|$)',
        re.DOTALL
    )

    for match in invoke_re.finditer(text):
        name = match.group(1)
        params_body = match.group(2)
        args = {}

        for param_match in param_re.finditer(params_body):
            val = param_match.group(2).strip()
            if val:
                args[param_match.group(1)] = val

        calls.append({
            "id": f"call_{__import__('uuid').uuid4().hex[:12]}",
            "type": "function",
            "function": {
                "name": name,
                "arguments": json.dumps(args, ensure_ascii=False)
            }
        })

    if calls:
        return calls

    # Pattern 3: Simple format <invoke tool="X">\nARGS_JSON\n</invoke>
    simple_re = re.compile(r'<invoke tool="([^"]+)">\s*\n?(\{.*?\})\n?\s*</invoke>', re.DOTALL)
    for match in simple_re.finditer(text):
        calls.append({
            "id": f"call_{__import__('uuid').uuid4().hex[:12]}",
            "type": "function",
            "function": {
                "name": match.group(1),
                "arguments": match.group(2)
            }
        })

    return calls if calls else None


def is_thinking_mode(model: str) -> bool:
    """Check if model name indicates extended thinking should be used."""
    return any(
        keyword in model.lower()
        for keyword in ["-think", "sonnet-4", "opus-4"]
    )


def get_default_max_tokens(model: str) -> int:
    """Get default max tokens for a model."""
    if "opus" in model.lower():
        return 4096
    if "sonnet" in model.lower():
        return 20000
    if "haiku" in model.lower():
        return 4096
    return 1024


def estimate_token_count(text: str) -> int:
    """
    Estimate token count for a text string.

    Uses a rough approximation: 1 token ≈ 4 characters for English,
    adjusted for common patterns.

    Args:
        text: Text to count tokens for

    Returns:
        Estimated token count
    """
    if not text:
        return 0

    # Rough approximation: 1 token ≈ 4 chars
    # This is commonly used in the industry
    char_count = len(text)
    token_estimate = char_count / 4

    # Adjust for common multi-token characters
    # Code blocks and special formatting tend to be more token-efficient
    # Non-English text may need adjustment
    if any(ord(c) > 127 for c in text):
        token_estimate *= 1.3  # Non-ASCII characters

    return int(token_estimate)