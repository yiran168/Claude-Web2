import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "../http-error.js";
import type { UpstreamKind } from "../domain.js";

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff");
}

export function validateUpstreamUrl(kind: UpstreamKind, rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "Upstream base URL is invalid", "invalid_upstream_url");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "Upstream base URL must use HTTPS", "insecure_upstream_url");
  if (url.username || url.password) throw new HttpError(400, "Credentials must not be embedded in an upstream URL", "invalid_upstream_url");
  if (url.hash || url.search) throw new HttpError(400, "Upstream base URL cannot contain a query or fragment", "invalid_upstream_url");
  if (kind === "anthropic" && url.origin !== "https://api.anthropic.com") {
    throw new HttpError(400, "Anthropic upstreams must use https://api.anthropic.com", "invalid_anthropic_origin");
  }
  return url;
}

export async function assertPublicDestination(url: URL): Promise<void> {
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new HttpError(400, "Private upstream destinations are disabled", "private_destination");
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new HttpError(400, "Upstream resolves to a private or reserved address", "private_destination");
  }
}

export function joinUpstreamPath(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base);
}
