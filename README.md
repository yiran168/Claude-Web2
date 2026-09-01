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

- Python 3.12+
- Docker & Docker Compose (recommended)
- [Claude.ai](https://claude.ai) account
- Valid session key or OAuth token

### Option 1: Docker Deployment (Recommended)

#### Deploy to VPS

Docker Compose is the fastest way to get started.

```bash
# 1. Clone the repository
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# 2. Copy environment configuration
cp .env.example .env

# 3. Edit .env file (see local deployment below for details)
vim .env

# 4. Build and start the service
docker-compose up -d

# 5. Check service status
docker-compose ps

# 6. View logs
docker-compose logs -f
```

**VPS Deployment Notes:**
- Ensure firewall allows port 8088 (`ufw allow 8088`)
- Service will be available at `http://[VPS-IP]:8088`
- Recommended to set up domain reverse proxy (Caddy/Nginx)

#### Local Deployment

```bash
# 1. Clone the repository
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# 2. Copy environment configuration
cp .env.example .env

# 3. Edit .env file
# Set SESSIONS field to your Claude.ai session keys list
# Format: ["sk-ant-sid01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]

# 4. Build and start
docker-compose up -d

# 5. Access frontend
http://localhost:8088
```

**Local vs VPS Differences:**
| Aspect | Local Deployment | VPS Deployment |
|--------|------------------|----------------|
| Access URL | `http://localhost:8088` | `http://[VPS-IP]:8088` |
| Firewall | No configuration needed | Open port 8088 |
| Domain | Not required | Optional reverse proxy |
| External Access | No | Yes |

### Option 2: Direct Run

```bash
# 1. Clone the repository
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# 2. Install dependencies
pip install -r requirements.txt

# 3. Copy environment configuration
cp .env.example .env

# 4. Edit .env with your session information

# 5. Start service
python -m uvicorn app.main:app --host 0.0.0.0 --port 8088

# 6. Access frontend
http://localhost:8088
```

### Configuration

After copying `.env.example` to `.env`, edit it with your Claude session information:

```bash
# Required: Get this from your Claude.ai session cookie

# Method 1: Session keys list (JSON array format)
SESSIONS=["sk-ant-sid01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]

# Method 2: OAuth tokens list (JSON array format)
# OAUTH_TOKENS=[{"access_token":"xxx","refresh_token":"yyy","expires_at":1234567890}]

# Method 3: Cookie strings list (JSON array format)
# COOKIES=[{"claude.ai": [{"name": "sessionKey", "value": "xxx"}]}]

# Optional: API key authentication
API_KEY=your-api-key-here

# Server settings
HOST=0.0.0.0
PORT=8088
```

#### Get Claude.ai Session Key

1. Open browser and login to [claude.ai](https://claude.ai)
2. Press `F12` to open Developer Tools
3. Navigate to **Application → Cookies**
4. Find and copy `sessionKey` value (format: `sk-ant-sid01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

### Verify Installation

```bash
# Health check
curl http://localhost:8088/health/health

# Expected response:
# {"status": "healthy"}
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SESSIONS` | No | `[]` | Claude.ai session keys list (JSON array) |
| `OAUTH_TOKENS` | No | `[]` | OAuth tokens list (JSON array) |
| `COOKIES` | No | `[]` | Cookie strings list (JSON array) |
| `API_KEY` | No | - | Backend API authentication key |
| `PORT` | No | `8088` | Server port |
| `HOST` | No | `0.0.0.0` | Server host |
| `LOG_LEVEL` | No | `INFO` | Logging level |

## 🖥️ Frontend Usage

### Access Frontend

Open browser: `http://localhost:8088` or `http://[VPS-IP]:8088`

### Frontend Features

- **Chat Interface**: Real-time chat with Claude
- **Session Management**: Create and manage multiple conversations
- **Model Selection**: Switch between different Claude models
- **Tool Calling**: Visualize AI tool call process
- **Streaming Response**: Real-time display of AI responses
- **Chat Export**: Export conversation history

### Frontend Routes

```
http://localhost:8088/
├── Chat Interface (/chat)   - Main conversation page
├── Settings (/settings)     - Model and parameter configuration
└── Health Check (/health)   - Service status monitoring
```

### Frontend Configuration

After opening the frontend in browser:
1. Click the **Settings** button in the top-right corner
2. Select Claude model (default: `claude-sonnet-4-20250514` - automatically fetched from Claude.ai)
3. Adjust parameters (Temperature, Max Tokens, etc.)
4. Click **Save** to apply settings

### Frontend Screenshots

```
Dashboard:                           Chat Interface:
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  Claude Web Interface       │     │  New Chat                   │
│                             │     │                             │
│  [Settings] [Models]         │     │  ┌───────────────────────┐  │
│  ─────────────────────────  │     │  │ Hello, how can I help?│  │
│                             │     │  │                       │  │
│  Available Models:          │     │  └───────────────────────┘  │
│  • claude-sonnet-4-20250514 │     │                             │
│  • claude-opus-4-20250514   │     │  [Type message...]          │
│  • claude-3-7-sonnet-20250219    │  │  [Send] [Upload Image]    │
│  • claude-3-5-sonnet-20241022    │  └─────────────────────────────┘
└─────────────────────────────┘
```

### Frontend API Integration

The frontend includes JavaScript SDK for easy integration:

```javascript
// Initialize frontend client
const client = new ClaudeWebClient('http://localhost:8088', 'your-api-key');

// Send a message
const response = await client.chat.completions.create({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

## 📖 Usage

### OpenAI API

```bash
curl http://localhost:8088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"Hello"}]}'
```

### Claude Native API

```bash
curl http://localhost:8088/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","messages":[{"role":"user","content":"Hello"}]}'
```

### Tool Calling

```bash
curl http://localhost:8088/v1/chat/completions \
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
