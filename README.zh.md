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

- Python 3.12+
- Docker & Docker Compose（推荐）
- [Claude.ai](https://claude.ai) 账户
- 有效的会话密钥或 OAuth 令牌

### 选项 1: Docker 部署（推荐）

#### 部署到 VPS

Docker Compose 是最快速的启动方式。

```bash
# 1. 克隆仓库
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# 2. 复制环境配置
cp .env.example .env

# 3. 编辑 .env 文件（本地部署请见下文）
vim .env

# 4. 构建并启动服务
docker-compose up -d

# 5. 检查状态
docker-compose ps

# 6. 查看日志
docker-compose logs -f
```

**VPS 部署注意事项:**
- 确保防火墙已开放 8088 端口 (`ufw allow 8088`)
- 服务将在 `http://[VPS-IP]:8088` 可用
- 建议配置域名反向代理 (Caddy/Nginx)

#### 本地部署

```bash
# 1. 克隆仓库
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# 2. 复制环境配置  
cp .env.example .env

# 3. 编辑 .env 文件
# 将 SESSIONS 字段设置为你的 Claude.ai 会话密钥列表
# 格式: ["sk-ant-sid01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]

# 4. 构建并启动
docker-compose up -d

# 5. 访问前端界面
http://localhost:8088
```

**本地 vs VPS 区别:**
| 项目 | 本地部署 | VPS 部署 |
|------|----------|----------|
| 访问地址 | `http://localhost:8088` | `http://[VPS-IP]:8088` |
| 防火墙 | 无需配置 | 需要开放 8088 端口 |
| 域名 | 不需要 | 可选配置反向代理 |
| 外部访问 | 否 | 是 |

### 选项 2: 直接运行

```bash
# 1. 克隆仓库
git clone https://github.com/yiran168/Claude-Web2.git
cd Claude-Web2

# 2. 安装依赖
pip install -r requirements.txt

# 3. 复制环境配置
cp .env.example .env

# 4. 编辑 .env 添加你的会话信息

# 5. 启动服务
python -m uvicorn app.main:app --host 0.0.0.0 --port 8088

# 6. 访问前端
http://localhost:8088
```

### 配置

复制 `.env.example` 到 `.env` 后，编辑以添加你的 Claude 会话信息：

```bash
# 必填: 从 Claude.ai 获取会话密钥

# 方法 1: 会话密钥列表 (JSON 数组格式)
SESSIONS=["sk-ant-sid01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]

# 方法 2: OAuth 令牌列表 (JSON 数组格式)
# OAUTH_TOKENS=[{"access_token":"xxx","refresh_token":"yyy","expires_at":1234567890}]

# 方法 3: Cookie 字符串列表 (JSON 数组格式)
# COOKIES=[{"claude.ai": [{"name": "sessionKey", "value": "xxx"}]}]

# 可选: API 密钥认证
API_KEY=your-api-key-here

# 服务器设置
HOST=0.0.0.0
PORT=8088
```

#### 获取 Claude.ai 会话密钥

1. 打开浏览器，登录 [claude.ai](https://claude.ai)
2. 按 `F12` 打开开发者工具
3. 在 **Application → Cookies** 中找到 `sessionKey`
4. 复制其值 (格式: `sk-ant-sid01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

### 验证安装

```bash
# 健康检查
curl http://localhost:8088/health/health

# 预期响应:
# {"status": "healthy"}
```

### 环境变量

| 变量 | 必填 | 默认 | 描述 |
|------|------|------|------|
| `SESSIONS` | 否 | `[]` | Claude.ai 会话密钥列表 (JSON 数组格式) |
| `OAUTH_TOKENS` | 否 | `[]` | OAuth 令牌列表 (JSON 数组格式) |
| `COOKIES` | 否 | `[]` | Cookie 字符串列表 (JSON 数组格式) |
| `API_KEY` | 否 | - | 后端 API 认证密钥 |
| `PORT` | 否 | `8088` | 服务器端口 |
| `HOST` | 否 | `0.0.0.0` | 服务器主机 |
| `LOG_LEVEL` | 否 | `INFO` | 日志级别 |

## 🖥️ 前端使用

### 访问前端

浏览器打开: `http://localhost:8088` 或 `http://[VPS-IP]:8088`

### 前端功能

- **聊天对话**: 实时与 Claude 进行对话
- **会话管理**: 创建和管理多个聊天会话
- **模型选择**: 切换不同的 Claude 模型
- **工具调用**: 可视化显示 AI 工具调用过程
- **流式响应**: 实时显示 AI 回答内容
- **对话导出**: 导出聊天记录

### 前端界面说明

```
http://localhost:8088/
├── 聊天页面 (/chat)      - 主要对话界面
├── 设置页面 (/settings)  - 模型和参数配置
└── 健康检查 (/health)    - 服务状态监控
```

### 前端配置

在浏览器中打开前端后:
1. 点击右上角 **设置** 按钮
2. 选择 Claude 模型 (默认: `claude-sonnet-4-20250514` - 自动从 Claude.ai 获取)
3. 调整参数 (Temperature, Max Tokens 等)
4. 点击 **保存** 应用设置

### 前端界面预览

```
仪表盘:                             聊天界面:
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  Claude Web 接口            │     │  新建对话                  │
│                             │     │                             │
│  [设置] [模型]               │     │  ┌───────────────────────┐  │
│  ─────────────────────────  │     │  │ 你好，有什么可以帮助你的？│  │
│                             │     │  │                       │  │
│  可用模型:                   │     │  └───────────────────────┘  │
│  • claude-sonnet-4-20250514 │     │                             │
│  • claude-opus-4-20250514   │     │  [输入消息...]              │
│  • claude-3-7-sonnet-20250219 │   │  [发送] [上传图片]          │
│  • claude-3-5-sonnet-20241022 │  └─────────────────────────────┘
└─────────────────────────────┘
```

### 前端 API 集成

前端包含 JavaScript SDK 便于集成:

```javascript
// 初始化前端客户端
const client = new ClaudeWebClient('http://localhost:8088', '你的API密钥');

// 发送消息
const response = await client.chat.completions.create({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: '你好！' }]
});
```

## 📖 使用方法

### OpenAI API

```bash
curl http://localhost:8088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"你好"}]}'
```

### Claude 原生 API

```bash
curl http://localhost:8088/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","messages":[{"role":"user","content":"你好"}]}'
```

### 工具调用

```bash
curl http://localhost:8088/v1/chat/completions \
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