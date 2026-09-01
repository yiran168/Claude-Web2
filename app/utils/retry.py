"""Retry utilities for transient failures."""

import asyncio
import functools
import random
from typing import Callable, Type, Tuple, Optional, Awaitable, Any
from loguru import logger

from app.core.exceptions import AppError


def is_retryable_error(exc: Exception) -> bool:
    """Check if an exception is retryable."""
    from app.core.exceptions import (
        CloudflareBlockedError,
        ClaudeRateLimitedError,
    )

    retryable_types = (
        CloudflareBlockedError,
        ClaudeRateLimitedError,
        asyncio.TimeoutError,
        ConnectionError,
    )

    # Also check for httpx transport errors
    try:
        import httpx

        retryable_types = retryable_types + (
            httpx.ConnectError,
            httpx.ReadTimeout,
            httpx.WriteTimeout,
            httpx.PoolTimeout,
            httpx.NetworkError,
        )
    except ImportError:
        pass

    if isinstance(exc, retryable_types):
        return True

    # Check error message for common transient issues
    exc_str = str(exc).lower()
    transient_patterns = [
        "tls",
        "ssl",
        "connection reset",
        "broken pipe",
        "timeout",
        "cloudflare",
        "429",
        "rate limit",
    ]
    return any(pattern in exc_str for pattern in transient_patterns)


def log_before_sleep(
    retry_state: Any,
) -> None:
    """Log retry attempt before sleeping."""
    exc = retry_state.outcome.exception()
    attempt = retry_state.attempt_number
    if attempt > 1:
        logger.warning(
            f"Retrying after error ({exc}); attempt {attempt}",
        )


async def async_retry(
    func: Callable[..., Awaitable[Any]],
    attempts: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    backoff_factor: float = 2.0,
    jitter: bool = True,
    retryable_exceptions: Optional[Tuple[Type[Exception], ...]] = None,
    should_retry: Optional[Callable[[Exception], bool]] = None,
    on_retry: Optional[Callable[[int, Exception], None]] = None,
) -> Any:
    """
    Async retry decorator with exponential backoff.

    Args:
        func: Async function to retry
        attempts: Max number of attempts
        base_delay: Base delay in seconds
        max_delay: Maximum delay between retries
        backoff_factor: Multiplier for delay between retries
        jitter: Add random jitter to delays
        retryable_exceptions: Exception types to retry on
        should_retry: Custom function to determine if error is retryable
        on_retry: Callback called before each retry with (attempt, exception)

    Returns:
        Result of the function call
    """
    last_exc = None

    for attempt in range(1, attempts + 1):
        try:
            return await func()
        except Exception as exc:
            last_exc = exc

            if retryable_exceptions and not isinstance(exc, retryable_exceptions):
                raise

            if should_retry and not should_retry(exc):
                raise

            if attempt >= attempts:
                raise

            if on_retry:
                on_retry(attempt, exc)

            # Calculate delay with exponential backoff
            delay = min(base_delay * (backoff_factor ** (attempt - 1)), max_delay)
            if jitter:
                delay *= 0.5 + random.random() * 0.5

            logger.warning(
                f"Attempt {attempt}/{attempts} failed: {exc}. Retrying in {delay:.1f}s...",
            )
            await asyncio.sleep(delay)

    raise last_exc


def log_before_sleep_tenacity(retry_state: Any) -> None:
    """Log retry attempt before sleeping (tenacity-compatible)."""
    exc = retry_state.outcome.exception()
    if retry_state.attempt_number > 1:
        logger.warning(f"Retrying after error: {exc}")