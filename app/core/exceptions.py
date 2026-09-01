"""Custom exceptions for Claude-Web2."""

from typing import Optional, Any


class AppError(Exception):
    """Base exception for all application errors."""

    def __init__(self, message: str, status_code: int = 500, **kwargs: Any):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.details = kwargs

    def __str__(self) -> str:
        if self.details:
            return f"{self.message} ({self.details})"
        return self.message


class ClaudeAuthError(AppError):
    """Authentication failed for Claude.ai."""

    def __init__(self, message: str = "Authentication failed", **kwargs: Any):
        super().__init__(message, status_code=401, **kwargs)


class ClaudeRateLimitedError(AppError):
    """Rate limited by Claude.ai."""

    def __init__(self, message: str = "Rate limited", resets_at: Optional[float] = None, **kwargs: Any):
        super().__init__(message, status_code=429, **kwargs)
        self.resets_at = resets_at


class ClaudeAuthInvalidError(AppError):
    """Invalid authorization / session expired."""

    def __init__(self, message: str = "Invalid authorization", **kwargs: Any):
        super().__init__(message, status_code=401, **kwargs)


class CloudflareBlockedError(AppError):
    """Cloudflare blocked the request."""

    def __init__(self, message: str = "Cloudflare blocked request", **kwargs: Any):
        super().__init__(message, status_code=403, **kwargs)


class OrganizationDisabledError(AppError):
    """Organization has been disabled."""

    def __init__(self, message: str = "Organization disabled", **kwargs: Any):
        super().__init__(message, status_code=403, **kwargs)


class NoAccountsAvailableError(AppError):
    """No valid accounts available."""

    def __init__(self, message: str = "No accounts available", **kwargs: Any):
        super().__init__(message, status_code=503, **kwargs)


class NoResponseError(AppError):
    """No response was generated."""

    def __init__(self, message: str = "No response generated", **kwargs: Any):
        super().__init__(message, status_code=500, **kwargs)


class NoValidMessagesError(AppError):
    """No valid messages found."""

    def __init__(self, message: str = "No valid messages found", **kwargs: Any):
        super().__init__(message, status_code=400, **kwargs)


class MessageParseError(AppError):
    """Failed to parse message."""


# Re-export as a tuple for broad exception catching
RETRYABLE_ERRORS = (
    CloudflareBlockedError,
    ClaudeRateLimitedError,
)