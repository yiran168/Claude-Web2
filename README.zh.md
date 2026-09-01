# Claude-Web2

> **Claude-Web2** — 现代化、高性能的 Claude.ai 网页代理，提供 OpenAI 兼容接口和 Claude 原生接口。

[English](README.md) | [中文](README.zh.md)

## 🌟 特色功能

| 功能 | 状态 | 描述 |
|------|------|------|
| **双重 API** | ✅ | OpenAI + Claude 原生 |
| **管道架构** | ✅ | 12 阶段可扩展处理器 |
| **多种认证** | ✅ | sessionKey + Cookie + OAuth2 |
| **负载均衡** | ✅ | 轮询 + 健康检查 |
| **自动故障转移** | ✅ | 在 429/错误时自动切换 |
| **SSE 流式** | ✅ | 完整的 OpenAI SSE 格式 |
| **工具调用** | ✅ | OpenAI ↔ Claude 转换 |
| **文件上传** | ✅ | base64 图片 + URL |
| **CF 绕过** | ✅ | curl-impersonate |
| **会话管理** | ✅ | SQLite + TTL 清理 |
| **Docker** | ✅ | 一键部署 |
| **管理员 API** | ✅ | 账户 + 系统管理 |

## 🚀 安装

### 前提条件

- Python 3.10+（推荐 3.12）
- Docker & Docker Compose（推荐）
- Poetry（可选，用于本地开发）
- [Claude.ai](https://claude.ai) 账户

### 选项 1: Docker（推荐）

Docker Compose 是最快速的启动方式，服务将在 `http://localhost:8000` 运行。

```bash
# 克隆仓库
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# 复制环境配置
cp .env.example .env

# 编辑 .env 添加你的 Claude 会话令牌
# 详情见下文"配置"部分

# 构建并启动服务
docker-compose up -d

# 检查状态
docker-compose ps
```

API 将在 `http://localhost:8000` 可用。

### 选项 2: Poetry（开发）

用于本地开发和调试：

```bash
# 安装 Poetry
curl -sSL https://install.python-poetry.org | python3 -

# 克隆仓库
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# 安装依赖
poetry install --only=main

# 复制环境配置
cp .env.example .env

# 编辑 .env 添加你的 Claude 会话令牌

# 启动服务器
poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 选项 3: 从源码（开发）

用于完整的开发环境（包含所有依赖）：

```bash
# 安装 Poetry
pip install poetry

# 克隆仓库
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# 安装所有依赖（包括开发工具）
poetry install

# 激活虚拟环境
poetry shell

# 复制环境配置
cp .env.example .env

# 编辑 .env 添加你的 Claude 会话令牌

# 启用热重载（开发模式）
python -m uvicorn app.main:app --reload
```

### 配置

复制 `.env.example` 到 `.env` 后，编辑以添加你的 Claude 会话信息：

```bash
# 必填: 从 Claude.ai 会话 Cookie 中获取

# 方法 1: 直接会话密钥（来自 Cookie）
CLAUDE_SESSION_KEY=your_session_key_here

# 方法 2: 完整的 Cookie 字符串
# CLAUDE_COOKIES="sessionKey=xxx; other_cookie=yyy"

# 方法 3: OAuth 令牌（企业版）
# CLAUDE_OAUTH_TOKEN=your_oauth_token_here
```

### 验证安装

安装后，验证服务是否正常运行：

```bash
# 健康检查
curl http://localhost:8000/health

# 期望响应:
# {"status": "healthy"}
```

### 环境变量

| 变量 | 必填 | 默认 | 描述 |
|------|------|------|------|
| `CLAUDE_SESSION_KEY` | 是 | - | Claude.ai 会话密钥 |
| `PORT` | 否 | `8000` | 服务器端口 |
| `HOST` | 否 | `0.0.0.0` | 服务器主机 |
| `LOG_LEVEL` | 否 | `INFO` | 日志级别 |

## 📖 使用

### OpenAI API

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"你好"}]}'
```

### Claude 原生 API

```bash
curl http://localhost:8000/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","messages":[{"role":"user","content":"你好"}]}'
```

### 工具调用

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"东京天气怎么样？"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"获取天气","parameters":{"type":"object","properties":{"location":{"type":"string"}}}}]}'
```

## 📊 对比

| 功能 | clove | Chat2API | Claude2api | **Claude-Web2** |
|------|-------|----------|------------|-----------------|
| 双重 API | ❌ | ✅ | ✅ | ✅ |
| 管道架构 | ✅ | ❌ | ❌ | ✅ |
| 负载均衡 | ❌ | ✅ | ❌ | ✅ |
| 自动故障转移 | ❌ | ❌ | ❌ | ✅ |
| CF 绕过 | curl_cffi | ❌ | ❌ | curl-impersonate |
| 可扩展性 | ⭐⭐ | ⭐⭐ | ⭐ | ⭐⭐⭐⭐⭐ |

## 🔧 许可证

MIT