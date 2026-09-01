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

### Docker (Recommended)

```bash
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2
cp .env.example .env
docker-compose up -d
```

### Poetry

```bash
curl -sSL https://install.python-poetry.org | python3 -
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2
poetry install --only=main
cp .env.example .env
poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### From Source

```bash
pip install poetry
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2
poetry install
poetry shell
python -m uvicorn app.main:app --reload
```

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
