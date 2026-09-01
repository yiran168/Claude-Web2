# Claude-Web2

> **Claude-Web2** — 现代化、高性能的 Claude.ai 网页代理，提供 OpenAI 兼容接口和 Claude 原生接口。

## 🌟 Features / 特色

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

## 🚀 Installation / 安装

### Prerequisites / 前提条件

- Python 3.10+ (3.12 recommended) / Python 3.10+（推荐 3.12）
- Docker & Docker Compose (推荐) / Docker & Docker Compose (recommended)
- Poetry (可选) / Poetry (optional, for local development)
- [Claude.ai](https://claude.ai) account with active session / Claude.ai 账户

### Option 1: Docker (Recommended) / 选项 1: Docker（推荐）

Docker compose is the fastest way to get started. The service will run on `http://localhost:8000`.

Docker Compose 是最快速的启动方式，服务将在 `http://localhost:8000` 运行。

```bash
# Clone the repository / 克隆仓库
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# Copy environment configuration / 复制环境配置
cp .env.example .env

# Edit .env to add your Claude session token / 编辑 .env 添加你的 Claude 会话令牌
# See "Configuration" section below for details / 详情见下文"配置"部分

# Build and start the service / 构建并启动服务
docker-compose up -d

# Check status / 检查状态
docker-compose ps
```

The API will be available at `http://localhost:8000`.

API 将在 `http://localhost:8000` 可用。

### Option 2: Poetry (Development) / 选项 2: Poetry（开发）

For local development and debugging:

用于本地开发和调试：

```bash
# Install Poetry / 安装 Poetry
curl -sSL https://install.python-poetry.org | python3 -

# Clone the repository / 克隆仓库
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# Install dependencies / 安装依赖
poetry install --only=main

# Copy environment configuration / 复制环境配置
cp .env.example .env

# Edit .env to add your Claude session token / 编辑 .env 添加你的 Claude 会话令牌
# See "Configuration" section below for details / 详情见下文"配置"部分

# Start the server / 启动服务器
poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Option 3: From Source (Development) / 选项 3: 从源码（开发）

For full development setup with all features:

用于完整的开发环境（包含所有依赖）：

```bash
# Install Poetry / 安装 Poetry
pip install poetry

# Clone the repository / 克隆仓库
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# Install all dependencies including dev tools / 安装所有依赖（包括开发工具）
poetry install

# Activate virtual environment / 激活虚拟环境
poetry shell

# Copy environment configuration / 复制环境配置
cp .env.example .env

# Edit .env to add your Claude session token / 编辑 .env 添加你的 Claude 会话令牌

# Start with hot reload for development / 启用热重载（开发模式）
python -m uvicorn app.main:app --reload
```

### Configuration / 配置

After copying `.env.example` to `.env`, edit it with your Claude session information:

复制 `.env.example` 到 `.env` 后，编辑以添加你的 Claude 会话信息：

```bash
# Required: Get this from your Claude.ai session cookie
# 必填: 从 Claude.ai 会话 Cookie 中获取

# Method 1: Direct session key (from cookie) / 方法 1: 直接会话密钥（来自 Cookie）
CLAUDE_SESSION_KEY=your_session_key_here

# Method 2: Full cookie string / 方法 2: 完整的 Cookie 字符串
# CLAUDE_COOKIES="sessionKey=xxx; other_cookie=yyy"

# Method 3: OAuth token (for enterprise) / 方法 3: OAuth 令牌（企业版）
# CLAUDE_OAUTH_TOKEN=your_oauth_token_here
```

### Verifying Installation / 验证安装

After installation, verify the service is running:

安装后，验证服务是否正常运行：

```bash
# Health check / 健康检查
curl http://localhost:8000/health

# Expected response / 期望响应:
# {"status": "healthy"}
```

### Environment Variables / 环境变量

| Variable | Required | Default | Description | 描述 |
|----------|----------|---------|-------------|------|
| `CLAUDE_SESSION_KEY` | Yes | - | Claude.ai session key | Claude.ai 会话密钥 |
| `PORT` | No | `8000` | Server port | 服务器端口 |
| `HOST` | No | `0.0.0.0` | Server host | 服务器主机 |
| `LOG_LEVEL` | No | `INFO` | Logging level | 日志级别 |

## 📖 Usage / 使用

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

## 📊 Comparison / 对比

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
