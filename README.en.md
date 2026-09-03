# Claude Web2

Claude Web2 is a dual-protocol AI gateway and visual control plane for **authorized Claude API upstreams**. It exposes OpenAI Chat Completions and Anthropic Messages compatible endpoints while handling model aliases, gateway-key policy, streaming conversion, health-aware routing, rate limits, and audit metadata.

Windows, Mac, local Linux, and server containers all run the same browser-based Web application; there is no native desktop client. Local installs use the loopback URL, while server deployments expose the complete console through an HTTPS domain.

> This is not a `claude.ai` web reverse-engineering tool. It does not extract or inject third-party cookies/session keys, impersonate OAuth identities, bypass CAPTCHA/Cloudflare/TLS fingerprints, or rotate accounts to evade quotas. Use an official Anthropic API key or another compatible upstream you are explicitly authorized to use.

[中文文档](README.md)

## Highlights

- `/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`, and `/v1/models`.
- OpenAI, Anthropic, or dual-mode gateway keys. Only an HMAC is stored; plaintext is revealed once.
- Text, image, document, tool-use, thinking, structured-output, prompt-caching extension blocks, and SSE streaming conversion.
- Health-aware priority pools with weighted least-load, round-robin, or priority-only routing. Retries stop after the first response byte.
- RPM, TPM, concurrency, model allowlist, IP allowlist, expiry, and revocation controls.
- Per-model input/output pricing, request-cost tracking, and per-key UTC daily USD budgets with preflight reservation and actual-usage settlement.
- Complete responsive React console: dashboard, playground, keys, upstreams, models, traces, audit, and settings.
- In-console local administrator password rotation with automatic revocation of the account's other sessions.
- Standards-based OIDC Authorization Code + PKCE for administrators, with group allowlists, explicit linking, and optional provisioning.
- SQLite WAL, AES-256-GCM secret storage, Argon2id passwords, HttpOnly sessions, separate CSRF tokens, and SSRF controls.
- Prompt bodies, response bodies, attachments, tool arguments, and raw secrets are never written to request logs.

## Quick start

Node.js 24+ is required. The same commands work in Windows PowerShell, macOS Terminal, and Linux shells; setup does not depend on `cp`, Bash, or PowerShell-specific scripting.

```bash
npm ci
npm run setup
```

The setup command creates `.env`, generates the master key and bootstrap password, and prints the password once. Save it, then run:

```bash
npm run local
```

`npm run local` validates the configuration, rebuilds the production React Web console when sources changed, and starts the server. Open `http://127.0.0.1:8787`. Create an authorized upstream, a model alias, and a gateway key. After the database has been initialized, `CW2_ADMIN_PASSWORD` can be removed from the runtime environment. Keep `CW2_MASTER_KEY` stable and backed up: changing it makes existing encrypted credentials unreadable.

Windows, Intel/Apple Silicon Mac, and local Linux do not require Docker. After the first `npm ci`, normal local use only needs `npm run local`; the explicit `npm run doctor && npm run build && npm start` sequence remains available.

Setup refuses to overwrite an existing `.env` by default. Use `npm run setup -- --force` only when you intentionally want to replace it. See the [deployment guide](docs/DEPLOYMENT.en.md) for platform, container, HTTPS proxy, and upgrade details.

For development:

```bash
npm run dev
```

## Docker

Prepare `.env`, validate the rendered Compose configuration, and start the service:

```bash
npm run setup
docker compose config
docker compose up -d --build
```

The included Compose stack binds only to host loopback, runs as a non-root user with a read-only root filesystem and dropped capabilities, and stores SQLite data in the `claude-web2-data` volume. The Dockerfile does not pin a CPU platform, so Docker can build the native image on supported AMD64 or ARM64 Mac/Linux hosts. Put a trusted HTTPS reverse proxy in front for production.

Keep `CW2_BIND_ADDRESS=127.0.0.1` for a same-host reverse proxy. Set it to `0.0.0.0` only after a firewall or trusted HTTPS ingress is in place.

Create or verify a WAL-safe online backup on a local host or inside the running container with `npm run backup` and `npm run backup -- --verify path/to/backup.db`. The command runs SQLite `quick_check`, verifies core tables, and writes a SHA-256 manifest. Backups remain sensitive and require the separately retained original `CW2_MASTER_KEY`.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `CW2_MASTER_KEY` | required | `base64:` or `hex:` value decoding to exactly 32 bytes. |
| `CW2_ADMIN_PASSWORD` | required once | Bootstrap password for a new database; minimum 12 characters. |
| `CW2_ADMIN_USERNAME` | `admin` | Bootstrap administrator name. |
| `CW2_HOST` | `127.0.0.1` | Listen address. Compose overrides this to `0.0.0.0`. |
| `CW2_PORT` | `8787` | HTTP listen port. |
| `CW2_DATA_DIR` | `./data` | SQLite/runtime-data directory. |
| `CW2_BIND_ADDRESS` | `127.0.0.1` | Compose-only host publishing address; it is not the backend listen setting. |
| `CW2_TRUST_PROXY` | `false` | Enable only behind a trusted, correctly configured proxy. |
| `CW2_SECURE_COOKIES` | `auto` | `true`, `false`, or inferred from the public URL/listen address. |
| `CW2_ALLOWED_ORIGINS` | empty | Additional browser origins, comma-separated. |
| `CW2_PUBLIC_URL` | empty | External origin required for OIDC, e.g. `https://gateway.example.com`; no path. |
| `CW2_LOG_LEVEL` | `info` | Fastify/Pino log level. |

## API examples

OpenAI style:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer gw-oai_REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-default","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

Anthropic style:

```bash
curl -N http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: gw-ant_REPLACE_ME" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-default","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

An `anthropic` upstream is locked to `https://api.anthropic.com` and `x-api-key`. A `compatible` upstream may use `x-api-key` or Bearer, but must resolve to a public HTTPS destination. Redirects, private/reserved destinations, and URL-embedded credentials are rejected.

Model prices are operator-maintained in USD per million tokens and are used only for local estimates and budget enforcement; they are not synchronized from provider pricing. A zero-priced model does not consume cost budget. Daily limits reset at UTC midnight, reserve the estimated request cost before dispatch, and settle against actual upstream usage.

## OIDC

Set `CW2_PUBLIC_URL`, register `/api/admin/v1/oidc/callback` at the provider, and configure OIDC from Settings. When automatic provisioning is off, use **Link current administrator** while signed in with the bootstrap account. Exact group allowlists are strongly recommended when provisioning is enabled.

The implementation requires Authorization Code, S256 PKCE, a one-time state bound to the initiating browser, nonce, short-lived transactions, public HTTPS metadata endpoints without redirects, and ID-token signature/issuer/audience/authorized-party/time validation. Only RS256, PS256, ES256, and EdDSA are accepted.

## Operations and security

- Keep `CW2_MASTER_KEY` in a secret manager; never commit it or bake it into an image.
- Use HTTPS in production and enforce secure cookies.
- Apply least privilege to gateway-key model/IP/rate/concurrency policy, and rotate keys regularly.
- Rotate the local administrator password from Settings; automatically provisioned OIDC accounts do not receive a usable local password.
- `/health/live` checks liveness; `/health/ready` also checks SQLite.
- Stop the service before a simple volume copy, or use an SQLite-aware online backup. Do not copy only the main database while WAL is active.
- This release targets a single SQLite-backed instance. Multi-node deployment requires shared transactional storage for sessions, limit counters, routing state, and data.

## Verification

```bash
npm run doctor
npm run typecheck
npm test
npm run build
```

Repository CI runs these checks with Node.js 24 on Windows, macOS, and Ubuntu, then builds the container for both `linux/amd64` and `linux/arm64` with Buildx.
