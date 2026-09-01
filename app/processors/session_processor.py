"""Session management processor for the pipeline."""

from typing import Optional, Dict, Any
from loguru import logger
from datetime import datetime

from app.processors.base import BaseProcessor
from app.processors.context import ClaudeAIContext
from app.services.session_manager import session_manager as SessionManager
from app.utils.messages import is_thinking_mode


class SessionProcessor(BaseProcessor):
    """
    Manage Claude.ai sessions throughout the request lifecycle.

    This processor:
    1. Creates or retrieves a session for the user
    2. Initializes conversation if needed
    3. Sets up thinking mode (paprika_mode)
    4. Uploads files/images if needed
    5. Cleans up session after response

    For tool call round-trips, the session is preserved to continue the conversation.
    """

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Initialize session and conversation.

        Requires:
            - account in context
            - claude_web_request in context
            - session_id in metadata (optional, for session reuse)

        Produces:
            - claude_client in context
            - claude_session in context
            - conv_uuid in metadata
        """
        if context.claude_client and context.claude_session:
            logger.debug("Skipping SessionProcessor - already initialized")
            return context

        if not context.account:
            logger.warning("Skipping SessionProcessor - no account")
            return context

        if not context.claude_web_request:
            logger.warning("Skipping SessionProcessor - no claude_web_request")
            return context

        # Create or get session
        session_id = context.metadata.get("session_id")
        if not session_id:
            session_id = f"sess_{int(datetime.now().timestamp() * 1000)}"
            context.metadata["session_id"] = session_id

        # Get or create client
        if not context.claude_client:
            from app.clients.claude_web import ClaudeWebClient
            from app.clients.base import ClaudeAPIClient

            if context.backend_type == "api" and context.account.oauth_token:
                # Use native API client for OAuth accounts
                context.claude_client = ClaudeAPIClient(
                    api_key=context.account.oauth_token.access_token,
                    base_url="https://api.anthropic.com",
                )
            else:
                # Use web client for session keys/cookies
                context.claude_client = ClaudeWebClient(
                    account=context.account,
                    proxy=None,
                )

            await context.claude_client.initialize()

        # Create or get session
        session = await SessionManager.get_or_create_session(session_id)
        context.claude_session = session

        # Initialize session with client
        if not session.initialized:
            await session.set_client(context.claude_client)
            await session.initialize()
            logger.info(f"Initialized session: {session_id}")

        # Handle thinking mode
        paprika_mode = context.metadata.get("paprika_mode")
        if paprika_mode:
            if context.account.is_pro:
                await context.claude_client.update_user_setting("paprika_mode", "extended")
                logger.debug(f"Enabled extended thinking mode for session {session_id}")

        # Upload images if present
        images = context.metadata.get("images")
        if images:
            await self._upload_images(context, images, session)

        logger.debug(f"Session ready: {session_id}, conv: {session.conv_uuid}")

        return context

    async def _upload_images(
        self, context: ClaudeAIContext, images: list, session
    ) -> None:
        """Upload images and add to the request."""
        from app.clients.claude_web import ClaudeWebClient

        if not isinstance(context.claude_client, ClaudeWebClient):
            # API client handles images differently
            return

        file_ids = []

        for i, img in enumerate(images):
            try:
                if "data" in img:
                    # Base64 image
                    image_data = img["data"]
                    # Parse data URL
                    parts = image_data.split(",", 1)
                    if len(parts) != 2:
                        logger.error(f"Invalid image data URL at index {i}")
                        continue

                    # Get content type
                    mime_part = parts[0].split(":")[1].split(";")[0]
                    base64_data = parts[1]

                    import base64
                    image_bytes = base64.b64decode(base64_data)

                    # Determine filename
                    ext = mime_part.split("/")[-1] if "/" in mime_part else "png"
                    filename = f"image_{i}.{ext}"

                    file_id = await session.upload_file(
                        file_data=image_bytes,
                        filename=filename,
                        content_type=mime_part,
                    )
                    if file_id:
                        file_ids.append(file_id)

                elif "url" in img:
                    # External URL - download and upload
                    await self._download_and_upload(img["url"], i, file_ids, session)

            except Exception as e:
                logger.error(f"Failed to upload image {i}: {e}")

        if file_ids:
            context.claude_web_request.files = file_ids
            logger.info(f"Uploaded {len(file_ids)} images for session")


    async def _download_and_upload(
        self, url: str, index: int, file_ids: list, session
    ) -> None:
        """Download an external image and upload to Claude."""
        from app.core.http_client import get_client
        from app.config import settings

        try:
            async with get_client(
                impersonate="chrome",
                proxy=settings.proxy,
            ) as client:
                response = await client.get(url)
                if response.status_code != 200:
                    logger.error(f"Failed to download image from {url}")
                    return

                content_type = response.headers.get("content-type", "image/png")
                image_bytes = response.content

                ext = content_type.split("/")[-1] if "/" in content_type else "png"
                filename = f"image_{index}.{ext}"

                file_id = await session.upload_file(
                    file_data=image_bytes,
                    filename=filename,
                    content_type=content_type,
                )
                if file_id:
                    file_ids.append(file_id)

        except Exception as e:
            logger.error(f"Error downloading/uploading image from {url}: {e}")


class SessionCleanupProcessor(BaseProcessor):
    """
    Clean up sessions after response is sent.
    """

    async def process(self, context: ClaudeAIContext) -> ClaudeAIContext:
        """
        Clean up session after successful response.
        Runs near end of pipeline.

        Note: This doesn't block the response - cleanup happens in background.
        """
        # Don't cleanup sessions with pending tool calls
        if context.tool_calls:
            logger.debug(f"Skipping cleanup - {len(context.tool_calls)} pending tool calls")
            context.metadata["preserve_session"] = True
            return context

        # Schedule cleanup
        if context.claude_session and not context.metadata.get("preserve_session"):
            logger.debug("Scheduling session cleanup")

        return context