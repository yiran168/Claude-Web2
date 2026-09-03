export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly payload?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken = sessionStorage.getItem("cw2.csrf") ?? "";

export function setCsrfToken(value: string): void {
  csrfToken = value;
  if (value) sessionStorage.setItem("cw2.csrf", value);
  else sessionStorage.removeItem("cw2.csrf");
}

export function getCsrfToken(): string {
  return csrfToken;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) headers.set("x-cw2-csrf", csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const body = payload as { error?: { message?: string } } | null;
    throw new ApiError(response.status, body?.error?.message ?? `Request failed (${response.status})`, payload);
  }
  const session = payload as { csrfToken?: unknown } | null;
  if (typeof session?.csrfToken === "string") setCsrfToken(session.csrfToken);
  return payload as T;
}

export async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}
