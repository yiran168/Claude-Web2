"""Account manager with load balancing and health tracking."""

from typing import Optional, List, Dict, Any
import threading
import asyncio
from datetime import datetime, timedelta, timezone
from loguru import logger

from app.core.account import Account, AuthType, AccountStatusEnum, OAuthToken
from app.core.exceptions import NoAccountsAvailableError
from app.core.http_client import get_client, build_claude_headers
from app.config import settings


class AccountManager:
    """
    Singleton manager for Claude.ai accounts with load balancing.

    Features:
    - Round-robin account selection
    - Health tracking (valid/rate_limited/invalid)
    - Automatic failover
    - Rate limit recovery
    - Support for multiple auth methods (session_key, cookie, OAuth)
    """

    _instance: Optional["AccountManager"] = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True

        self._accounts: Dict[str, Account] = {}  # identifier -> Account
        self._lock: asyncio.Lock = None  # Will be initialized lazily
        self._current_index = 0
        self._check_interval = settings.account_check_interval

        logger.info("AccountManager initialized")

    def _get_lock(self) -> asyncio.Lock:
        """Get or create asyncio lock."""
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def _init_from_config(self):
        """Initialize accounts from configuration."""
        # Load from sessions (session keys)
        for session_key in settings.sessions:
            identifier = session_key[:20] + "..." if len(session_key) > 20 else session_key
            await self.add_account(
                identifier=identifier,
                auth_type=AuthType.SESSION_KEY,
                session_key=session_key,
            )

        # Load from cookies
        for cookie in settings.cookies:
            identifier = f"cookie_{hash(cookie) % 10000}"
            await self.add_account(
                identifier=identifier,
                auth_type=AuthType.COOKIE,
                cookie_value=cookie,
            )

        # Load from OAuth tokens
        for token_str in settings.oauth_tokens:
            try:
                token_data = eval(token_str) if isinstance(token_str, str) else token_str
                identifier = f"oauth_{hash(token_data.get('access_token', '')) % 10000}"
                oauth_token = OAuthToken.from_dict(token_data)
                await self.add_account(
                    identifier=identifier,
                    auth_type=AuthType.OAUTH,
                    oauth_token=oauth_token,
                )
            except Exception as e:
                logger.error(f"Failed to load OAuth token: {e}")

        logger.info(f"AccountManager loaded {len(self._accounts)} accounts from config")

    async def add_account(
        self,
        identifier: str,
        auth_type: AuthType,
        session_key: Optional[str] = None,
        cookie_value: Optional[str] = None,
        oauth_token: Optional[OAuthToken] = None,
        organization_uuid: Optional[str] = None,
    ) -> Account:
        """
        Add or update an account.

        Args:
            identifier: Unique identifier for the account
            auth_type: Authentication type
            session_key: Session key (sk-ant-sid01-*)
            cookie_value: Cookie string
            oauth_token: OAuth token pair
            organization_uuid: Org UUID (will be fetched if not provided)

        Returns:
            The created/updated Account
        """
        async with self._get_lock():
            existing = self._accounts.get(identifier)
            if existing:
                # Update existing account
                if session_key:
                    existing.session_key = session_key
                if cookie_value:
                    existing.cookie_value = cookie_value
                if oauth_token:
                    existing.oauth_token = oauth_token
                existing.mark_valid()
                logger.info(f"Updated account: {identifier}")
                return existing

            # Fetch organization UUID if not provided
            if not organization_uuid:
                organization_uuid = await self._fetch_org_uuid(
                    auth_type, session_key, cookie_value, oauth_token
                )

            account = Account(
                organization_uuid=organization_uuid or "unknown",
                display_name=identifier,
                auth_type=auth_type,
                session_key=session_key,
                cookie_value=cookie_value,
                oauth_token=oauth_token,
            )

            self._accounts[identifier] = account
            logger.info(f"Added account: {identifier} (auth_type: {auth_type.value})")
            return account

    async def remove_account(self, identifier: str) -> bool:
        """Remove an account by identifier."""
        async with self._get_lock():
            if identifier in self._accounts:
                del self._accounts[identifier]
                logger.info(f"Removed account: {identifier}")
                return True
            return False

    async def get_account(self, identifier: str) -> Optional[Account]:
        """Get a specific account by identifier."""
        async with self._get_lock():
            return self._accounts.get(identifier)

    async def list_accounts(self) -> List[Account]:
        """List all accounts."""
        async with self._get_lock():
            return list(self._accounts.values())

    async def get_available_account(self, preferred_model: Optional[str] = None) -> Account:
        """
        Get an available account with round-robin load balancing.

        Args:
            preferred_model: If set, try to find an account with Pro/Max for this model

        Returns:
            An available Account

        Raises:
            NoAccountsAvailableError if no accounts are available
        """
        async with self._get_lock():
            if not self._accounts:
                raise NoAccountsAvailableError("No accounts configured")

            # Filter available accounts
            available = [a for a in self._accounts.values() if a.is_available]

            if not available:
                # Try to recover rate-limited accounts
                await self._recover_rate_limited_accounts(available)
                if not available:
                    raise NoAccountsAvailableError(
                        f"No accounts available. All accounts are invalid or rate limited."
                    )

            # Sort by capabilities if a preferred model is specified
            if preferred_model:
                available.sort(
                    key=lambda a: 1 if a.is_pro else 0,
                    reverse=True
                )

            # Round-robin selection
            account = available[self._current_index % len(available)]
            self._current_index = (self._current_index + 1) % len(available)

            self._accounts[account.display_name].last_used = datetime.now(timezone.utc)
            return account

    async def _recover_rate_limited_accounts(self, available: List[Account]) -> None:
        """Recover accounts that are no longer rate limited."""
        for account in self._accounts.values():
            if (account.status == AccountStatusEnum.RATE_LIMITED
                and account.rate_limit_reset
                and datetime.now(timezone.utc) >= account.rate_limit_reset):
                account.mark_valid()
                logger.info(f"Account {account.display_name} recovered from rate limit")

    async def _fetch_org_uuid(
        self,
        auth_type: AuthType,
        session_key: Optional[str],
        cookie_value: Optional[str],
        oauth_token: Optional[OAuthToken],
    ) -> Optional[str]:
        """Fetch organization UUID from Claude.ai."""
        if auth_type not in (AuthType.SESSION_KEY, AuthType.COOKIE, AuthType.OAUTH):
            return None

        cookie = None
        if session_key:
            cookie = f"sessionKey={session_key}"
        elif cookie_value:
            cookie = cookie_value

        headers = await build_claude_headers(cookie or "")
        if oauth_token:
            headers["Authorization"] = f"Bearer {oauth_token.access_token}"

        try:
            async with get_client(
                impersonate="chrome",
                proxy=settings.proxy,
                headers=headers,
            ) as client:
                response = await client.get(
                    f"{settings.claude_ai_url}/api/organizations"
                )

                if response.status_code == 403:
                    raise Exception("Access denied (403) - possibly Cloudflare blocked")

                if response.status_code == 401:
                    raise Exception("Authentication failed (401)")

                if response.status_code != 200:
                    logger.warning(f"Failed to fetch org UUID: {response.status_code}")
                    return None

                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    # Find org with chat capability
                    for org in data:
                        if "uuid" in org and "capabilities" in org:
                            caps = org.get("capabilities", [])
                            if "chat" in caps:
                                return org["uuid"]
                    # Fallback to first org
                    return data[0].get("uuid")
                return None

        except Exception as e:
            logger.error(f"Error fetching org UUID: {e}")
            if "403" in str(e) or "401" in str(e) or "Cloudflare" in str(e):
                return None
            return None

    async def get_account_for_model(self, model: str) -> Account:
        """
        Get an account that can access the specified model.
        Pro/Max accounts can access more models.
        """
        async with self._get_lock():
            # Check if model requires Pro/Max
            pro_models = ["claude-3-opus", "gpt-4-turbo"]
            needs_pro = any(pm in model.lower() for pm in ["opus", "gpt-4"])

            available = [a for a in self._accounts.values() if a.is_available]

            if needs_pro:
                pro_accounts = [a for a in available if a.is_pro]
                if pro_accounts:
                    # Round-robin among pro accounts
                    account = pro_accounts[self._current_index % len(pro_accounts)]
                    self._current_index = (self._current_index + 1) % len(pro_accounts)
                    account.last_used = datetime.now(timezone.utc)
                    return account

            # Fall back to any available account
            return await self.get_available_account(model)

    def to_dict(self) -> List[dict]:
        """Serialize all accounts."""
        async def _to_dict():
            async with self._get_lock():
                return [a.to_dict() for a in self._accounts.values()]
        return asyncio.create_task(_to_dict())

    def get_stats(self) -> Dict[str, Any]:
        """Get account statistics."""
        total = len(self._accounts)
        valid = sum(1 for a in self._accounts.values() if a.is_available)
        rate_limited = sum(1 for a in self._accounts.values() if a.status == AccountStatusEnum.RATE_LIMITED)
        invalid = sum(1 for a in self._accounts.values() if a.status == AccountStatusEnum.INVALID)

        return {
            "total": total,
            "available": valid,
            "rate_limited": rate_limited,
            "invalid": invalid,
            "accounts": [a.display_name for a in self._accounts.values()],
        }


account_manager = AccountManager()