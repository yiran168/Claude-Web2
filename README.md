# Claude-Web2

High-performance Claude.ai web-to-API proxy with OpenAI-compatible and Claude-native interfaces.

## Features

- **Dual API Compatibility**: OpenAI API format and native Anthropic API format
- **Multi-Auth Support**: sessionKey (sk-ant-sid01-*), Cookies, OAuth
- **SSE Streaming**: Full streaming with tool call support
- **Tool Calling**: Full round-trip tool call conversion between OpenAI and Claude formats
- **Image Uploads**: Support for base64 and URL images
- **Account Load Balancing**: Round-robin with health tracking and failover
- **Automatic Recovery**: Rate limit handling and account switching
- **Cloudflare Bypass**: Uses curl-impersonate for reliable access
- **Docker Ready**: Includes Dockerfile and docker-compose.yml

## Quick Start

```bash
# Clone and setup
git clone https://github.com/your-org/claude-web2.git
cd claude-web2

# Install
pip install poetry
poetry install

# Configure
cp .env.example .env
# Edit .env to add your CLAUDE session keys

# Run
poetry run python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## Usage

### OpenAI-compatible API

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Claude-native API

```bash
curl http://localhost:8000/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Tool Calling

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather info",
        "parameters": {
          "type": "object",
          "properties": {"location": {"type": "string"}},
          "required": ["location"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

### Tool Result (Session Resume)

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {"role": "user", "content": "What is the weather in Tokyo?"},
      {"role": "assistant", "content": "", "tool_calls": [{"id": "call_abc123", "type": "function", "function": {"name": "get_weather", "arguments": "{\"location\":\"Tokyo\"}"}}]},
      {"role": "tool", "content": "{\"temperature\": 22, \"condition\": \"sunny\"}", "tool_call_id": "call_abc123"}
    ],
    "tools": [...],
    "tool_choice": "auto"
  }'
```

## Configuration

| Variable          | Description                          | Default      |
|-------------------|--------------------------------------|--------------|
| `SESSIONS`        | Claude session keys (one per line)   | -            |
| `COOKIES`         | Claude.ai cookies                    | -            |
| `OAUTH_TOKENS`    | OAuth token pairs                    | -            |
| `PROXY`           | HTTP/SOCKS proxy for requests        | -            |
| `DEFAULT_MODEL`   | Default Claude model                 | claude-3-5-sonnet-20241022 |
| `RETRY_ATTEMPTS`  | Max retry attempts                   | 3            |
| `SESSION_TIMEOUT` | Session idle timeout (seconds)       | 600          |

## Architecture

```
Client
   │
   ▼
FastAPI App
   │
   ▼
ClaudeAIPipeline  ───► [AuthProcessor]      ── account selection
                      [FormatProcessor]    ── OpenAI → Claude format
                      [SessionProcessor]   ── create/reuse session
                      [ClaudeWebProcessor] ── send to claude.ai
                      [EventParsingProcessor] ── parse SSE
                      [ToolCallProcessor]    ── handle tool calls
                      [MessageCollector]   ── collect response
                      [StreamingResponseProcessor]
                      [NonStreamingResponseProcessor]
```

### Processors

Each processor in the pipeline follows the `BaseProcessor` interface:

```python
class MyProcessor(BaseProcessor):
    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        # Process the request
        return context
```

### Backends

- `claude_web.py` — Claude.ai web API (primary, most reliable)
- `base.py` — Native Anthropic API (OAuth accounts)

## Docker

```bash
docker-compose up -d
```

## License

MIT