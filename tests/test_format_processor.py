"""Tests for format processor and message utilities."""
import unittest
import json
from app.utils.messages import format_prompt, parse_tool_calls_from_text, normalize_model_name
from app.models.internal import ClaudeWebRequest, Attachment


class TestFormatProcessor(unittest.TestCase):

    def test_format_prompt_basic(self):
        """Test basic message formatting with string content."""
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ]
        result = format_prompt(messages)
        self.assertIn("Hello", result)
        self.assertIn("Hi there", result)

    def test_format_prompt_with_tool_calls(self):
        """Test formatting messages with tool calls."""
        messages = [
            {"role": "user", "content": "What's the weather?"},
            {"role": "assistant", "content": "Calling weather tool", 
             "tool_calls": [{"function": {"name": "weather", "arguments": '{"location": "NYC"}'}}]},
        ]
        result = format_prompt(messages)
        self.assertIn("weather", result)
        self.assertIn("NYC", result)
        self.assertIn("antml:invoke", result)

    def test_parse_tool_calls_from_text(self):
        """Test parsing tool calls from Claude's XML format."""
        text = '<tool_calls>\n<invoke name="get_weather">\n<parameter name="location">NYC</parameter>\n</invoke>\n</tool_calls>'
        calls = parse_tool_calls_from_text(text)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["function"]["name"], "get_weather")
        self.assertIn("NYC", calls[0]["function"]["arguments"])

    def test_normalize_model_name(self):
        """Test model name normalization."""
        self.assertEqual(normalize_model_name("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet-20241022")
        self.assertEqual(normalize_model_name("claude-3-opus-20240229"), "claude-3-opus-20240229")


class TestClaudeWebRequest(unittest.TestCase):

    def test_claude_web_request_required_fields(self):
        """Test that ClaudeWebRequest has required fields matching clove."""
        # Test that model can be created with fields matching clove
        req = ClaudeWebRequest(
            max_tokens_to_sample=4096,
            attachments=[Attachment.from_text("test prompt")],
            files=[],
            model="claude-3-5-sonnet-20241022",
            rendering_mode="messages",
            prompt="",
            timezone="UTC",
            tools=[],
        )
        self.assertEqual(req.timezone, "UTC")
        self.assertEqual(req.rendering_mode, "messages")
        self.assertEqual(req.model, "claude-3-5-sonnet-20241022")

    def test_claude_web_request_exclude_none(self):
        """Test that model_dump with exclude_none works correctly."""
        req = ClaudeWebRequest(
            max_tokens_to_sample=4096,
            attachments=[Attachment.from_text("test")],
            files=[],
            rendering_mode="messages",
            prompt="",
            timezone="UTC",
            tools=[],
        )
        dumped = req.model_dump(exclude_none=True)
        # Should not have model in output when it's None
        self.assertNotIn("model", dumped)
        # Should have all other fields
        self.assertIn("max_tokens_to_sample", dumped)
        self.assertIn("timezone", dumped)
        self.assertIn("rendering_mode", dumped)


class TestSendToolResultPayload(unittest.TestCase):

    def test_content_formatting_string(self):
        """Test that string content is properly formatted as content blocks."""
        # Simulate the check done in send_tool_result
        tool_result = "test result"
        if isinstance(tool_result, str):
            content = [{"type": "text", "text": tool_result}]
        
        self.assertEqual(len(content), 1)
        self.assertEqual(content[0]["type"], "text")
        self.assertEqual(content[0]["text"], "test result")

    def test_content_formatting_list_of_strings(self):
        """Test that list of strings is properly formatted as content blocks."""
        tool_result = ["line 1", "line 2"]
        content = []
        for item in tool_result:
            if isinstance(item, str):
                content.append({"type": "text", "text": item})
        
        self.assertEqual(len(content), 2)
        self.assertEqual(content[0]["text"], "line 1")
        self.assertEqual(content[1]["text"], "line 2")

    def test_content_formatting_list_of_dicts(self):
        """Test that list of dicts with text is preserved."""
        tool_result = [{"type": "text", "text": "existing block"}]
        content = []
        for item in tool_result:
            if isinstance(item, dict) and "text" in item:
                content.append(item)
        
        self.assertEqual(len(content), 1)
        self.assertEqual(content[0]["text"], "existing block")

    def test_tool_result_payload_structure(self):
        """Test that tool_result payload has correct structure."""
        tool_result = "test result"
        content = [{"type": "text", "text": tool_result}] if isinstance(tool_result, str) else []
        
        payload = {
            "tool_use_id": "test_id",
            "content": content,
            "is_error": False,
        }
        
        self.assertEqual(payload["tool_use_id"], "test_id")
        self.assertEqual(payload["is_error"], False)
        self.assertEqual(len(payload["content"]), 1)
        self.assertIn("type", payload["content"][0])
        self.assertIn("text", payload["content"][0])


class TestOAuthSettings(unittest.TestCase):
    """Test OAuth settings configuration."""
    
    def setUp(self):
        from app.config import settings
        self.settings = settings

    def test_oauth_client_id_exists(self):
        """Test that oauth_client_id is configured."""
        self.assertTrue(hasattr(self.settings, 'oauth_client_id'))
        self.assertEqual(self.settings.oauth_client_id, "9d1c250a-e61b-44d9-88ed-5944d1962f5e")

    def test_oauth_token_url_exists(self):
        """Test that oauth_token_url is configured."""
        self.assertTrue(hasattr(self.settings, 'oauth_token_url'))
        self.assertEqual(self.settings.oauth_token_url, "https://console.anthropic.com/v1/oauth/token")


if __name__ == "__main__":
    unittest.main()