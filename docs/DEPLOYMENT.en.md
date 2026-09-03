# Claude Web2 deployment guide

Claude Web2 uses standard Node.js filesystem, networking, and SQLite APIs. Its setup and diagnostic commands are pure Node.js, with no Bash, PowerShell, Python, Go, or local C/C++ compiler requirement.

Every deployment is browser-based. One Fastify production process serves the React SPA, management API, and both compatible API formats; no separate frontend server or desktop client is required:

| Location | Web console | API base URL |
|---|---|---|
| Local Windows / Mac / Linux | `http://127.0.0.1:8787` | `http://127.0.0.1:8787/v1` |
| Server container | `https://gateway.example.com` | `https://gateway.example.com/v1` |

## Supported paths

| Environment | Architecture | Recommended path | Data location |
|---|---|---|---|
| Windows local | x64 or native Node.js on Windows ARM | Node.js 24+ | `./data` |
| macOS local | Intel or Apple Silicon | Node.js 24+ | `./data` |
| Linux server | amd64 or arm64 | Docker Compose | `claude-web2-data` volume |
| Docker Desktop on Mac | Intel or Apple Silicon | Docker Compose | Docker Desktop volume |

The Dockerfile does not pin `platform`. A normal `docker compose up --build` builds for the host architecture; use Buildx only when publishing an amd64/arm64 image manifest to a registry.

## Local installation

Run the same commands in Windows PowerShell, macOS Terminal, or a Linux shell:

```bash
npm ci
npm run setup
npm run local
```

The setup command creates the ignored `.env`, generates the AES master key and bootstrap password from the operating system CSPRNG, and binds to `127.0.0.1:8787` by default. It prints the password once. After the first successful login, remove `CW2_ADMIN_PASSWORD` from the runtime environment, but keep the same `CW2_MASTER_KEY` securely backed up.

`npm run local` is a pure Node.js launcher. It runs the deployment doctor and rebuilds the production Web console when the build is missing or source files changed. Use `npm run local -- --no-build` to explicitly reuse the current build or `npm run local -- --build` to force a rebuild.

If `.env` was prepared separately, run `npm run doctor`. It does not reveal secrets or make external network requests. Machine-readable output is available with `npm run doctor -- --json`.

On Apple Silicon, install native arm64 Node.js and leave Compose without a `platform` override; this avoids unnecessary emulation. On Windows, the npm commands work in PowerShell, Windows Terminal, and `cmd.exe`. Docker Desktop should use Linux containers. The named volume avoids host-path syntax differences.

## Linux server container

Create `.env`, then set the production-facing values:

```dotenv
CW2_BIND_ADDRESS=127.0.0.1
CW2_PUBLIC_URL=https://gateway.example.com
CW2_TRUST_PROXY=true
CW2_SECURE_COOKIES=true
```

Start and inspect the stack:

```bash
npm run setup
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 claude-web2
```

On a Docker-only Linux host with no Node.js installation, build the image and use its bundled setup command:

```bash
docker build -t claude-web2:local .
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/workspace" claude-web2:local node /app/scripts/setup.mjs --output /workspace/.env
docker compose up -d
```

The running image also includes the deployment doctor: `docker compose exec claude-web2 npm run doctor`. It reads the injected process environment and does not require `.env` inside the image.

Run an online backup without stopping the service with `docker compose exec claude-web2 npm run backup`. The default `/app/data/backups` location is inside the data volume, so copy verified backup/manifest pairs to independent storage regularly; losing the same volume would otherwise remove both the live database and its local backups.

Keep the default loopback publish address when Caddy or Nginx runs on the same server. Set `CW2_BIND_ADDRESS=0.0.0.0` only when a firewall restricts sources and a trusted HTTPS ingress is already in place. The container listens internally on port 8787; `CW2_PORT` controls the published host port.

Minimal same-host Caddy configuration:

```caddyfile
gateway.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Nginx must disable response buffering so SSE remains real-time:

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

Enable `CW2_TRUST_PROXY=true` only when that proxy is the sole trusted ingress. `CW2_PUBLIC_URL` must be the externally visible HTTPS origin without a path.

## Persistence, upgrades, and diagnostics

The Compose service runs as a non-root user with a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, a separate `/tmp`, a readiness health check, and data isolated in the `claude-web2-data` volume.

Back up `.env` and the data volume before upgrading. Stop the service for a simple volume copy, or use an SQLite/WAL-aware online backup mechanism. Upgrade with:

```bash
docker compose build --pull
docker compose up -d
docker compose ps
```

Do not rerun setup with `--force` during an upgrade: changing the master key makes saved upstream credentials and the OIDC client secret unreadable. Start troubleshooting with:

```bash
npm run doctor
docker compose config
docker compose logs --tail=200 claude-web2
```
