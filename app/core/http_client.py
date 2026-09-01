"""HTTP client with Cloudflare bypass via impersonation."""

from typing import Optional, Dict, Any
from contextlib import asynccontextmanager
from loguru import logger

try:
    from curl_cffi import AsyncClient as ImpersonateClient
    HAS_CURL_CFFI = True
except ImportError:
    logger.warning("curl_cffi not available, falling back to httpx")
    HAS_CURL_CFFI = False

import httpx


@asynccontextmanager
async def get_client(
    impersonate: str = "chrome",
    timeout: float = 60.0,
    proxy: Optional[str] = None,
    follow_redirects: bool = False,
    headers: Optional[Dict[str, str]] = None,
):
    """
    Get an HTTP client with impersonation support.

    Args:
        impersonate: Browser to impersonate ("chrome", "safari", etc.)
        timeout: Request timeout in seconds
        proxy: Proxy URL
        follow_redirects: Whether to follow redirects
        headers: Default headers to set

    Yields:
        HTTP client (httpx or curl_cffi)
    """
    if HAS_CURL_CFFI:
        client = ImpersonateClient(
            impersonate=impersonate,
            timeout=timeout,
            proxies=proxy,
            follow_redirects=follow_redirects,
            http2=True,  # Enable HTTP/2 for better Cloudflare bypass
        )
        if headers:
            client.headers.update(headers)
        try:
            yield client
        finally:
            await client.close()
    else:
        transport = httpx.AsyncHTTPTransport(
            proxy_url=proxy if proxy else None
        ) if proxy else None

        client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            follow_redirects=follow_redirects,
            headers=headers,
        )
        try:
            yield client
        finally:
            await client.close()


async def build_claude_headers(
    cookie: str,
    conv_uuid: Optional[str] = None,
    claude_url: str = "https://claude.ai",
) -> Dict[str, str]:
    """Build headers for Claude.ai API requests."""
    headers = {
        "Accept": "text/event-stream",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Cookie": cookie,
        "Origin": claude_url,
        "Referer": f"{claude_url}/new",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "priority": "u=1, i",
    }

    if conv_uuid:
        headers["Referer"] = f"{claude_url}/chat/{conv_uuid}"

    return headers


async def build_claude_api_headers(
    api_key: str,
) -> Dict[str, str]:
    """Build headers for Anthropic API requests."""
    return {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }