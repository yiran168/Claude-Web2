# Claude-Web2

> **Claude-Web2** — A modern, high-performance Claude.ai web proxy with OpenAI-compatible and native Claude APIs.

[English](README.md) | [中文](README.zh.md)

## 🌟 Features

| Feature | Status | Description |
|---------|--------|-------------|
| **Dual API** | ✅ | OpenAI + Claude native |
| **Pipeline Architecture** | ✅ | 12-stage extensible processors |
| **Multi-Auth** | ✅ | sessionKey + Cookie + OAuth2 |
| **Load Balancing** | ✅ | Round-robin + health check |
| **Auto Failover** | ✅ | Auto switch on 429/errors |
| **SSE Streaming** | ✅ | Full OpenAI SSE format |
| **Tool Calling** | ✅ | OpenAI ↔ Claude conversion |
| **File Upload** | ✅ | base64 image + URL |
| **CF Bypass** | ✅ | curl-impersonate |
| **Session Mgmt** | ✅ | SQLite + TTL cleanup |
| **Docker** | ✅ | One-click deploy |
| **Admin API** | ✅ | Account + system management |

## 🚀 Installation

### Prerequisites

- Python 3.10+ (3.12 recommended)
- Docker & Docker Compose (recommended)
- Poetry (optional, for local development)
- [Claude.ai](https://claude.ai) account with active session

### Option 1: Docker (Recommended)

Docker compose is the fastest way to get started. The service will run on `http://localhost:8000`.

```bash
# Clone the repository
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# Copy environment configuration
cp .env.example .env

# Edit .env to add your Claude session token
# See "Configuration" section below for details

# Build and start the service
docker-compose up -d

# Check status
docker-compose ps
```

The API will be available at `http://localhost:8000`.

### Option 2: Poetry (Development)

For local development and debugging:

```bash
# Install Poetry
curl -sSL https://install.python-poetry.org | python3 -

# Clone the repository
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# Install dependencies
poetry install --only=main

# Copy environment configuration
cp .env.example .env

# Edit .env to add your Claude session token

# Start the server
poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Option 3: From Source (Development)

For full development setup with all features:

```bash
# Install Poetry
pip install poetry

# Clone the repository
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# Install all dependencies including dev tools
poetry install

# Activate virtual environment
poetry shell

# Copy environment configuration
cp .env.example .env

# Edit .env to add your Claude session token

# Start with hot reload for development
python -m uvicorn app.main:app --reload
```

### Configuration

After copying `.env.example` to `.env`, edit it with your Claude session information:

```bash
# Required: Get this from your Claude.ai session cookie

# Method 1: Direct session key (from cookie)
CLAUDE_SESSION_KEY=your_session_key_here

# Method 2: Full cookie string
# CLAUDE_COOKIES="sessionKey=xxx; other_cookie=yyy"

# Method 3: OAuth token (for enterprise)
# CLAUDE_OAUTH_TOKEN=your_oauth_token_here
```

### Verifying Installation

After installation, verify the service is running:

```bash
# Health check
curl http://localhost:8000/health

# Expected response:
# {"status": "healthy"}
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLAUDE_SESSION_KEY` | Yes | - | Claude.ai session key |
| `PORT` | No | `8000` | Server port |
| `HOST` | No | `0.0.0.0` | Server host |
| `LOG_LEVEL` | No | `INFO` | Logging level |

## 📖 Usage

### OpenAI API

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"Hello"}]}'
```

### Claude Native API

```bash
curl http://localhost:8000/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","messages":[{"role":"user","content":"Hello"}]}'
```

### Tool Calling

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"Weather in Tokyo?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"location":{"type":"string"}}}}]}'
```

## 📊 Comparison

| Feature | clove | Chat2API | Claude2api | **Claude-Web2** |
|---------|-------|----------|------------|-----------------|
| Dual API | ❌ | ✅ | ✅ | ✅ |
| Pipeline | ✅ | ❌ | ❌ | ✅ |
| Load Balancing | ❌ | ✅ | ❌ | ✅ |
| Auto Failover | ❌ | ❌ | ❌ | ✅ |
| CF Bypass | curl_cffi | ❌ | ❌ | curl-impersonate |
| Extensibility | ⭐⭐ | ⭐⭐ | ⭐ | ⭐⭐⭐⭐⭐ |

## 🔧 License

MIT
