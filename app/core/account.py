"""Claude account management with multiple authentication methods."""

from typing import Optional, List, Dict, Any, AsyncContextManager
from datetime import datetime, timedelta, timezone
from enum import Enum
from dataclasses import dataclass, field
from loguru import logger

from app.core.exceptions import ClaudeAuthInvalidError
from app.models.internal import AccountStatus


class AuthType(str, Enum):
    """Authentication type for Claude account."""
    SESSION_KEY = "session_key"
    COOKIE = "cookie"
    OAUTH = "oauth"
    BOTH = "both"


class AccountStatusEnum(str, Enum):
    """Account status."""
    VALID = "valid"
    INVALID = "invalid"
    RATE_LIMITED = "rate_limited"


@dataclass
class OAuthToken:
    """OAuth token pair."""
    access_token: str
    refresh_token: str
    expires_at: float  # Unix timestamp

    def is_expired(self, buffer: int = 300) -> bool:
        """Check if token is expired (with buffer)."""
        return datetime.now(timezone.utc).timestamp() > (self.expires_at - buffer)

    def to_dict(self) -> dict:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "OAuthToken":
        return cls(
            access_token=data["access_token"],
            refresh_token=data["refresh_token"],
            expires_at=data["expires_at"],
        )

    async def refresh(self) -> bool:
        """
        Refresh OAuth access token using refresh_token.
        Returns True if refresh succeeded.
        """
        import httpx
        
        token_url = "https://claude.ai/oauth/token"
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(token_url, data={
                    "grant_type": "refresh_token",
                    "refresh_token": self.refresh_token,
                    "client_id": "claude-web2",
                    "scope": "accounts:api_key write:ai_feedback write:chat_conversation read:notify",
                })
                if resp.status_code == 200:
                    data = resp.json()
                    self.access_token = data["access_token"]
                    self.expires_at = datetime.now(timezone.utc).timestamp() + data.get("expires_in", 3600)
                    logger.info("OAuth token refreshed successfully")
                    return True
                logger.error(f"OAuth refresh failed: {resp.status_code}")
        except Exception as e:
            logger.error(f"OAuth refresh error: {e}")
        return False


@dataclass
class Account:
    """
    Represents a Claude.ai account with authentication info.

    Supports three auth types:
    - session_key: sk-ant-sid01-* format (most reliable)
    - cookie: Netscape format cookies from claude.ai
    - oauth: OAuth2 token pair with PKCE
    """

    organization_uuid: str
    display_name: str
    auth_type: AuthType = AuthType.SESSION_KEY
    session_key: Optional[str] = None
    cookie_value: Optional[str] = None
    oauth_token: Optional[OAuthToken] = None
    capabilities: Optional[List[str]] = None
    status: AccountStatusEnum = AccountStatusEnum.VALID
    rate_limit_reset: Optional[datetime] = None
    last_used: Optional[datetime] = None
    model_mapping: Optional[Dict[str, str]] = None  # Custom model name overrides

    def __post_init__(self):
        if self.capabilities is None:
            self.capabilities = []
        if self.model_mapping is None:
            self.model_mapping = {}

    @property
    def is_pro(self) -> bool:
        """Check if account has Pro/Max capabilities."""
        if not self.capabilities:
            return False
        pro_keywords = ["pro", "enterprise", "raven", "max"]
        return any(
            keyword in cap.lower() for cap in self.capabilities
            for keyword in pro_keywords
        )

    @property
    def is_rate_limited(self) -> bool:
        """Check if account is currently rate limited."""
        if self.status != AccountStatusEnum.RATE_LIMITED:
            return False
        if self.rate_limit_reset is None:
            return False
        return datetime.now(timezone.utc) < self.rate_limit_reset

    async def handle_oauth_token(self):
        """Refresh OAuth token if expired."""
        if self.oauth_token and self.oauth_token.is_expired():
            logger.info(f"Refreshing OAuth token for {self.display_name}")
            return await self.oauth_token.refresh()
        return True

    @property
    def is_available(self) -> bool:
        """Check if account is available for use."""
        if self.status == AccountStatusEnum.INVALID:
            return False
        if self.is_rate_limited:
            return False
        return True

    def get_auth_header(self) -> Dict[str, str]:
        """Get authentication header for this account."""
        if self.auth_type in (AuthType.SESSION_KEY, AuthType.BOTH) and self.session_key:
            return {"Cookie": f"sessionKey={self.session_key}"}
        if self.auth_type in (AuthType.OAUTH, AuthType.BOTH) and self.oauth_token:
            return {"Authorization": f"Bearer {self.oauth_token.access_token}"}
        if self.auth_type in (AuthType.COOKIE, AuthType.BOTH) and self.cookie_value:
            return {"Cookie": self.cookie_value}
        return {}

    def get_cookie(self) -> Optional[str]:
        """Get the appropriate cookie string for requests."""
        if self.session_key:
            return f"sessionKey={self.session_key}"
        if self.cookie_value:
            return self.cookie_value
        return None

    def mark_rate_limited(self, reset_at: Optional[datetime] = None, retry_after: Optional[int] = None):
        """Mark account as rate limited."""
        self.status = AccountStatusEnum.RATE_LIMITED
        if reset_at:
            self.rate_limit_reset = reset_at
        elif retry_after:
            self.rate_limit_reset = datetime.now(timezone.utc) + timedelta(seconds=retry_after)
        else:
            # Default 1 minute rate limit
            self.rate_limit_reset = datetime.now(timezone.utc) + timedelta(seconds=60)
        logger.warning(f"Account {self.display_name} rate limited until {self.rate_limit_reset}")

    def mark_invalid(self):
        """Mark account as invalid."""
        self.status = AccountStatusEnum.INVALID
        logger.error(f"Account {self.display_name} marked as invalid")

    def mark_valid(self):
        """Mark account as valid."""
        if self.status != AccountStatusEnum.VALID:
            logger.info(f"Account {self.display_name} marked as valid again")
        self.status = AccountStatusEnum.VALID
        self.rate_limit_reset = None

    def to_dict(self) -> dict:
        """Serialize account to dictionary."""
        return {
            "organization_uuid": self.organization_uuid,
            "display_name": self.display_name,
            "auth_type": self.auth_type.value,
            "session_key": self.session_key,
            "cookie_value": self.cookie_value,
            "oauth_token": self.oauth_token.to_dict() if self.oauth_token else None,
            "capabilities": self.capabilities,
            "status": self.status.value,
            "rate_limit_reset": self.rate_limit_reset.isoformat() if self.rate_limit_reset else None,
            "last_used": self.last_used.isoformat() if self.last_used else None,
            "model_mapping": self.model_mapping,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Account":
        """Create account from dictionary."""
        account = cls(
            organization_uuid=data["organization_uuid"],
            display_name=data["display_name"],
            auth_type=AuthType(data["auth_type"]),
            session_key=data.get("session_key"),
            cookie_value=data.get("cookie_value"),
            capabilities=data.get("capabilities") or [],
            status=AccountStatusEnum(data.get("status", "valid")),
            model_mapping=data.get("model_mapping") or {},
        )

        if data.get("oauth_token"):
            account.oauth_token = OAuthToken.from_dict(data["oauth_token"])

        if data.get("rate_limit_reset"):
            account.rate_limit_reset = datetime.fromisoformat(data["rate_limit_reset"])

        if data.get("last_used"):
            account.last_used = datetime.fromisoformat(data["last_used"])

        return account