"""Main Claude web processor - orchestrates the request flow."""

from typing import Optional, Dict, Any
import time
import asyncio

from loguru import logger

from app.processors.base import BaseProcessor
from app.processors.context import ClaudeAIContext
from app.utils.retry import async_retry, is_retryable_error
from app.core.exceptions import (
    ClaudeAuthInvalidError,
    ClaudeRateLimitedError,
    NoAccountsAvailableError,
    AppError,
)
from app.config import settings as config_settings


class ClaudeWebProcessor(BaseProcessor):
    """
    Send the request to Claude.ai and produce the SSE stream.

    This processor:
    1. Uses the selected account and client
    2. Creates/reuses a conversation session
    3. Sends the formatted request
    4. Produces the original_stream (raw SSE from Claude)
    5. Handles retries and account failover
    """

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Send request to Claude.ai.

        Requires:
            - account in context
            - claude_web_request in context
            - claude_client in context
            - claude_session in context

        Produces:
            - original_stream in context (raw SSE chunks)
        """
        if context.original_stream:
            logger.debug("Skipping ClaudeWebProcessor - already has original_stream")
            return context

        if not context.account:
            logger.warning("Skipping ClaudeWebProcessor - no account")
            return context

        if not context.claude_web_request:
            logger.warning("Skipping ClaudeWebProcessor - no claude_web_request")
            return context

        if not context.claude_client:
            logger.warning("Skipping ClaudeWebProcessor - no claude_client")
            return context

        if not context.claude_session:
            logger.warning("Skipping ClaudeWebProcessor - no claude_session")
            return context

        # Get request parameters
        request = context.claude_web_request
        model = context.model or request.model
        stream = context.metadata.get("stream", True)
        max_tokens = request.max_tokens_to_sample
        attachments = request.attachments
        files = request.files
        tools = request.tools
        paprika_mode = context.metadata.get("paprika_mode")

        # Build the prompt from attachments
        prompt = ""
        if attachments:
            for att in attachments:
                if isinstance(att, dict) and "extracted_content" in att:
                    prompt = att["extracted_content"]
                    break

        # Send message with retry logic
        from app.services.account_manager import account_manager

        max_retries = config_settings.retry_attempts

        last_error = None
        for attempt in range(max_retries):
            try:
                # Ensure session is initialized
                if not context.claude_session.initialized:
                    await context.claude_session.set_client(context.claude_client)
                    await context.claude_session.initialize()

                # Send message
                logger.info(
                    f"Sending request to Claude.ai "
                    f"(conv: {context.claude_session.conv_uuid}, "
                    f"model: {model}, attempt: {attempt + 1})"
                )

                # Mark start time
                start_time = time.time()

                # Get the SSE stream
                stream_iter = await context.claude_client.send_message(
                    conv_uuid=context.claude_session.conv_uuid,
                    prompt=prompt,
                    model=model,
                    stream=True,  # Always stream, convert later if needed
                    max_tokens=max_tokens,
                    attachments=attachments,
                    files=files,
                    tools=tools,
                )

                # Store the stream in context
                context.original_stream = stream_iter
                context.metadata["request_time"] = start_time
                context.metadata["backend_type"] = context.backend_type

                logger.info(
                    f"Request sent successfully "
                    f"(conv: {context.claude_session.conv_uuid})"
                )
                return context

            except ClaudeRateLimitedError as e:
                last_error = e
                logger.warning(
                    f"Rate limited on attempt {attempt + 1}/{max_retries}: {e}"
                )

                # Mark account as rate limited
                if context.account:
                    context.account.mark_rate_limited(
                        retry_after=e.details.get("retry_after", 60)
                    )

                # Try to get another account
                if attempt < max_retries - 1:
                    try:
                        context.account = await account_manager.get_available_account(model)
                        logger.info(f"Switching to account: {context.account.display_name}")
                        # Re-initialize client
                        await self._reinit_client(context)
                    except NoAccountsAvailableError:
                        break
                await asyncio.sleep(2 ** attempt)

            except ClaudeAuthInvalidError as e:
                last_error = e
                # Mark account as invalid
                if context.account:
                    context.account.mark_invalid()
                    logger.error(f"Account marked invalid: {context.account.display_name}")

                # Try another account
                if attempt < max_retries - 1:
                    try:
                        context.account = await account_manager.get_available_account(model)
                        await self._reinit_client(context)
                        continue
                    except NoAccountsAvailableError:
                        break
                break

            except Exception as e:
                last_error = e
                if is_retryable_error(e):
                    logger.warning(
                        f"Retryable error on attempt {attempt + 1}/{max_retries}: {e}"
                    )
                    if attempt < max_retries - 1:
                        await asyncio.sleep(2 ** attempt)
                        continue
                else:
                    logger.error(f"Non-retryable error: {e}")
                    break

        # All retries exhausted
        if last_error:
            logger.error(f"All retries exhausted: {last_error}")
            raise AppError(
                f"Failed to get response from Claude after {max_retries} attempts: {last_error}",
                status_code=502,
            )
        else:
            raise AppError(
                "Failed to send request to Claude",
                status_code=502,
            )

    async def _reinit_client(self, context: ClaudeAIContext) -> None:
        """Re-initialize the client with a new account."""
        from app.clients.claude_web import ClaudeWebClient
        from app.clients.base import ClaudeAPIClient

        if context.backend_type == "api" and context.account.oauth_token:
            context.claude_client = ClaudeAPIClient(
                api_key=context.account.oauth_token.access_token,
                base_url="https://api.anthropic.com",
            )
        else:
            context.claude_client = ClaudeWebClient(
                account=context.account,
                proxy=None,
            )

        await context.claude_client.initialize()

        # Reset session
        context.claude_session.client = context.claude_client
        context.claude_session.initialized = False