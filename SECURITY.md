# Security policy

## Supported versions

Security fixes are applied to the latest revision of the default branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not include production API keys, master keys, OIDC client secrets, session cookies, prompts, responses, or customer data in a report. Use synthetic values and the smallest reproducible case.

## Deployment boundary

Claude Web2 is intended for official Anthropic API credentials and compatible upstreams the operator is explicitly authorized to use. Web-session cookie extraction/injection, OAuth impersonation, CAPTCHA/Cloudflare/TLS fingerprint bypass, and quota-evasion account rotation are outside the supported security boundary.

Operators are responsible for HTTPS termination, master-key custody, backups, upstream authorization, gateway-key policy, network egress controls, and timely dependency updates. See the security operations section in [README.md](README.md).
