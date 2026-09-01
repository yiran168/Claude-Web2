"""Account authentication processor for the pipeline."""

from loguru import logger

from app.processors.base import BaseProcessor
from app.processors.context import ClaudeAIContext
from app.services.account_manager import account_manager
from app.core.exceptions import NoAccountsAvailableError


class AuthProcessor(BaseProcessor):
    """
    Resolve authentication by selecting an available account.

    This processor:
    1. Determines required model/plan level
    2. Selects an available account via load balancing
    3. Checks account health and capabilities
    4. Handles rate-limited accounts with recovery
    """

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Resolve authentication and select an account.

        Requires:
            - openai_request in context (contains model name)

        Produces:
            - account in context
            - backend_type in context
        """
        if context.account:
            logger.debug("Skipping AuthProcessor - account already set")
            return context

        if not context.openai_request:
            logger.warning("Skipping AuthProcessor - no openai_request")
            return context

        model = context.openai_request.get("model", "")

        try:
            # Get an available account
            account = await account_manager.get_account_for_model(model)
            
            # Handle OAuth token refresh if needed
            if account.oauth_token and account.oauth_token.is_expired():
                logger.info(f"OAuth token expired, refreshing for {account.display_name}")
                refreshed = await account.oauth_token.refresh()
                if not refreshed:
                    logger.warning(f"OAuth refresh failed for {account.display_name}, marking invalid")
                    account.mark_invalid()
                    raise NoAccountsAvailableError("OAuth token refresh failed")
            
            context.account = account
            context.backend_type = self._determine_backend(account)

            logger.info(
                f"Selected account: {account.display_name} "
                f"(auth: {account.auth_type.value}, "
                f"pro: {account.is_pro})"
            )

            context.metadata["auth_processed"] = True

        except NoAccountsAvailableError as e:
            logger.error(f"No accounts available: {e}")
            raise
        except Exception as e:
            logger.error(f"Authentication failed: {e}")
            raise

        return context

    def _determine_backend(self, account) -> str:
        """Determine which backend to use for an account."""
        from app.core.account import AuthType

        if account.auth_type in (AuthType.OAUTH, AuthType.BOTH):
            return "api"  # Use native API for OAuth accounts
        return "web"  # Use web scraping for session keys/cookies