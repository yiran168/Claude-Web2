# Claude Web2 部署指南

项目使用 Node.js 标准文件、网络和 SQLite API，安装与自检脚本也是纯 Node.js；运行链路不要求 Bash、PowerShell、Python、Go 或本地 C/C++ 编译器。

所有部署形态都是 Web 端，生产构建由同一个 Fastify 进程交付 React SPA、管理 API 和两种兼容 API，不需要单独运行前端服务器：

| 部署位置 | Web 控制台 | API Base URL |
|---|---|---|
| Windows / Mac / Linux 本机 | `http://127.0.0.1:8787` | `http://127.0.0.1:8787/v1` |
| 服务器容器 | `https://gateway.example.com` | `https://gateway.example.com/v1` |

## 支持的运行方式

| 场景 | 架构 | 推荐方式 | 数据位置 |
|---|---|---|---|
| Windows 本机 | x64、Windows on ARM 的原生 Node.js | Node.js 24+ | `./data` |
| macOS 本机 | Intel、Apple Silicon | Node.js 24+ | `./data` |
| Linux 服务器 | amd64、arm64 | Docker Compose | 命名卷 `claude-web2-data` |
| Mac Docker Desktop | Intel、Apple Silicon | Docker Compose | Docker Desktop 命名卷 |

Dockerfile 没有 `platform` 硬编码。日常的 `docker compose up --build` 会构建宿主机原生架构；需要向镜像仓库同时发布 amd64/arm64 时，再使用 Buildx 的多平台构建能力。

## Windows、macOS 与 Linux 本机

在项目根目录运行以下完全相同的命令：

```bash
npm ci
npm run setup
npm run local
```

安装器会：

- 创建 Git 已忽略的 `.env`；
- 使用系统加密随机数生成 AES 主密钥；
- 生成满足首次登录要求的管理员密码，并只在终端显示一次；
- 默认只监听 `127.0.0.1:8787`。

浏览器打开 `http://127.0.0.1:8787`。首次登录成功后，从实际运行环境中删除 `CW2_ADMIN_PASSWORD`，但必须长期、安全地保存同一个 `CW2_MASTER_KEY`。

`npm run local` 是纯 Node.js 启动器：自动运行部署自检，并在生产构建缺失或源码更新后重新构建 Web 前端。使用 `npm run local -- --no-build` 可明确复用现有构建，`npm run local -- --build` 可强制重建。

如果已经手动准备了 `.env`，直接运行 `npm run doctor`。自检不会显示密钥或密码，也不会发起外部网络请求。机器可读输出使用：

```bash
npm run doctor -- --json
```

## macOS 注意事项

Intel Mac 安装 x64 Node.js，Apple Silicon 安装 arm64 Node.js；无需 Rosetta。建议确认 `node -p "process.platform + '/' + process.arch"` 输出与机器架构一致。POSIX 系统上的安装器会把 `.env` 权限设置为 `0600`。

使用 Docker Desktop 时不需要在 Compose 中增加 `platform`。硬编码 `linux/amd64` 会让 Apple Silicon 不必要地进入模拟模式，因此本项目有意让 Docker选择本机架构。

## Windows 注意事项

在 PowerShell、Windows Terminal 或 `cmd.exe` 中均可使用上面的 npm 命令。配置生成不使用 `cp`、`chmod` 或 Shell 字符串替换。Windows 会忽略 POSIX 的 `0600` 位，请依靠用户账户 ACL 保护 `.env`，不要把项目放进公开共享目录。

Docker Desktop 建议使用 Linux 容器模式。数据库保存在 Docker 命名卷中，不依赖 Windows 路径映射语法。

## Linux 服务器容器

1. 安装 Docker Engine 与 Compose 插件。
2. 在项目目录运行 `npm run setup`，保存终端显示的一次性管理员密码。
3. 编辑 `.env`，至少确认以下生产项：

```dotenv
CW2_BIND_ADDRESS=127.0.0.1
CW2_PUBLIC_URL=https://gateway.example.com
CW2_TRUST_PROXY=true
CW2_SECURE_COOKIES=true
```

4. 验证 Compose 展开结果并启动：

```bash
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 claude-web2
```

如果服务器只安装 Docker、没有宿主机 Node.js，可以先用镜像内置的同一个安装器生成 `.env`：

```bash
docker build -t claude-web2:local .
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/workspace" claude-web2:local node /app/scripts/setup.mjs --output /workspace/.env
docker compose up -d
```

运行中的容器也内置自检器：`docker compose exec claude-web2 npm run doctor`。它会直接读取容器环境，不要求镜像内存在 `.env`。

在线备份可以在服务运行时执行：

```bash
docker compose exec claude-web2 npm run backup
```

默认写入数据卷内的 `/app/data/backups`。这能生成一致性快照，但仍应定期把备份文件和对应清单复制到独立存储；否则删除或损坏同一个数据卷会同时丢失原库和备份。

默认的 `127.0.0.1` 发布方式适合同一台服务器上的 Caddy/Nginx。只有当 HTTPS 入口在另一台机器或外部负载均衡器上、并且防火墙已经限制来源时，才设置 `CW2_BIND_ADDRESS=0.0.0.0`。

Compose 内部固定让应用监听 `0.0.0.0:8787`，宿主机端口由 `.env` 的 `CW2_PORT` 控制。因此 `CW2_PORT=9000` 会得到宿主机 `127.0.0.1:9000` 到容器 `8787` 的映射。

## HTTPS 反向代理

Caddy 的最小同机配置：

```caddyfile
gateway.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Nginx 需要关闭响应缓冲以保持 SSE 实时流式输出：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

只有在代理是唯一可信入口时才启用 `CW2_TRUST_PROXY=true`。生产环境的 `CW2_PUBLIC_URL` 必须是外部可见的 HTTPS Origin，不能包含路径。

## 容器安全与持久化

Compose 默认具有以下约束：

- 非 root `node` 用户；
- 只读根文件系统和独立 `/tmp`；
- 丢弃全部 Linux capabilities；
- `no-new-privileges`；
- 数据只写入 `claude-web2-data` 命名卷；
- 由 `/health/ready` 驱动健康检查；
- 进程异常退出后自动重启。

不要把 `.env` 放进镜像，也不要提交到 Git。简单离线备份应先 `docker compose stop`，完整备份命名卷内容，再 `docker compose start`；运行中备份则应使用 SQLite 感知 WAL 的在线备份工具。

## 升级与回滚

升级前先备份数据卷与 `.env`，然后：

```bash
docker compose build --pull
docker compose up -d
docker compose ps
```

不要在升级时重新运行带 `--force` 的安装器，否则会更换主密钥，导致已加密的上游凭据和 OIDC Client Secret 无法解密。回滚时恢复旧镜像与配套的数据卷备份。

## 启动故障排查

按顺序检查：

```bash
npm run doctor
docker compose config
docker compose logs --tail=200 claude-web2
```

- `CW2_MASTER_KEY` 必须以 `base64:` 或 `hex:` 开头，解码后正好 32 字节。
- 新数据库必须有至少 12 位的 `CW2_ADMIN_PASSWORD`。
- `CW2_DATA_DIR` 必须可读写；容器中由命名卷提供。
- 本机已有服务占用端口时，修改 `.env` 的 `CW2_PORT`。
- 登录正常但 OIDC 回调失败时，核对 `CW2_PUBLIC_URL`、代理转发头和身份提供商登记的 `/api/admin/v1/oidc/callback`。
