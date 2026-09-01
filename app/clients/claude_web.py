"""Claude Web API client for scraping claude.ai."""

from typing import Optional, Dict, Any, AsyncIterator, List
from datetime import datetime
import json
import uuid as uuid_lib

from loguru import logger

from app.core.account import Account
from app.core.exceptions import (
    ClaudeAuthInvalidError,
    ClaudeRateLimitedError,
    CloudflareBlockedError,
    OrganizationDisabledError,
)
from app.core.http_client import get_client, build_claude_headers
from app.config import settings
from app.models.internal import ClaudeWebRequest


class ClaudeWebClient:
    """
    Client for interacting with Claude.ai's web API via scraping.

    This client communicates directly with claude.ai's internal API
    endpoints, mimicking the official web interface.

    Authentication methods:
    - sessionKey (sk-ant-sid01-*): Set via Cookie header
    - Cookie string: Full Netscape-format cookies
    - OAuth token: Bearer token authorization
    """

    BASE_URL = "https://claude.ai"
    API_VERSION = "2023-06-01"

    def __init__(self, account: Account, proxy: Optional[str] = None):
        self.account = account
        self.proxy = proxy or settings.proxy
        self._org_uuid: Optional[str] = None
        self._last_message_uuid: Optional[str] = None  # For session resume

    @property
    def org_uuid(self) -> Optional[str]:
        """Get organization UUID, fetching if necessary."""
        return self._org_uuid or self.account.organization_uuid

    @org_uuid.setter
    def org_uuid(self, value: str):
        self._org_uuid = value

    async def initialize(self) -> None:
        """Initialize the client by fetching organization UUID if needed."""
        if not self.org_uuid or self.org_uuid == "unknown":
            self._org_uuid = await self.get_organization_id()
            logger.info(f"ClaudeWebClient initialized with org: {self._org_uuid}")

    async def _request(
        self,
        method: str,
        path: str,
        headers: Optional[Dict[str, str]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        stream: bool = False,
        timeout: float = 30.0,
        conv_uuid: Optional[str] = None,
    ) -> Any:
        """
        Make an HTTP request to Claude.ai.

        Args:
            method: HTTP method
            path: API path (e.g., /api/organizations)
            headers: Additional headers
            json_data: JSON body
            stream: Whether to stream the response
            timeout: Request timeout
            conv_uuid: Conversation UUID for referer header

        Returns:
            HTTP response
        """
        url = f"{self.BASE_URL}{path}"

        # Build base headers
        cookie = self.account.get_cookie()
        base_headers = await build_claude_headers(
            cookie=cookie or "",
            conv_uuid=conv_uuid,
            claude_url=settings.claude_ai_url,
        )

        # Add OAuth token if available
        if self.account.oauth_token and self.account.auth_type in (
            "oauth", "both"
        ):
            base_headers["Authorization"] = f"Bearer {self.account.oauth_token.access_token}"
            base_headers.pop("Cookie", None)

        # Merge additional headers
        if headers:
            base_headers.update(headers)

        try:
            async with get_client(
                impersonate="chrome",
                timeout=timeout,
                proxy=self.proxy,
                headers=base_headers,
            ) as client:
                response = await client.request(
                    method=method,
                    url=url,
                    json=json_data,
                    stream=stream,
                )

                # Handle Cloudflare blocks
                if response.status_code == 302:
                    raise CloudflareBlockedError("Cloudflare blocked the request")

                # Handle auth errors
                if response.status_code == 401:
                    error_msg = await self._extract_error(response)
                    if "Invalid authorization" in error_msg:
                        raise ClaudeAuthInvalidError(error_msg)
                    raise ClaudeAuthInvalidError(error_msg)

                # Handle organization disabled
                if response.status_code == 400:
                    error_data = await self._safe_json(response)
                    error_body = error_data.get("error", {}).get("message", "")
                    if "disabled" in error_body.lower():
                        raise OrganizationDisabledError(error_body)

                # Handle rate limiting
                if response.status_code == 429:
                    await self._handle_rate_limit(response)

                return response

        except (CloudflareBlockedError, ClaudeAuthInvalidError, OrganizationDisabledError):
            raise
        except Exception as e:
            error_str = str(e)
            if "TLS" in error_str or "SSL" in error_str:
                # These are retryable transport errors
                logger.debug(f"Transport error (retryable): {e}")
            raise

    async def _safe_json(self, response: Any) -> Dict:
        """Safely extract JSON from response."""
        try:
            return response.json()
        except Exception:
            return {}

    async def _extract_error(self, response: Any) -> str:
        """Extract error message from response."""
        try:
            data = response.json()
            error = data.get("error", {})
            if isinstance(error, dict):
                return error.get("message", str(data))
            return str(data)
        except Exception:
            return f"HTTP {response.status_code}"

    async def _handle_rate_limit(self, response: Any):
        """Handle 429 rate limit response."""
        retry_after = None

        # Try Retry-After header
        ra = response.headers.get("retry-after") or response.headers.get("Retry-After")
        if ra:
            try:
                retry_after = int(ra)
            except ValueError:
                try:
                    retry_after = int(
                        datetime.strptime(ra, "%a, %d %b %Y %H:%M:%S %Z").timestamp()
                    )
                except Exception:
                    pass

        # Try body for resetsAt
        if not retry_after:
            try:
                data = await response.json()
                error_msg = data.get("error", {}).get("message", "")
                if error_msg and error_msg.startswith("{"):
                    error_data = json.loads(error_msg)
                    resets_at = error_data.get("resetsAt")
                    if resets_at and isinstance(resets_at, (int, float)):
                        retry_after = max(1, int(resets_at - datetime.now().timestamp()))
            except Exception:
                pass

        if not retry_after:
            retry_after = 60  # Default 1 minute

        self.account.mark_rate_limited(
            retry_after=retry_after
        )

        raise ClaudeRateLimitedError(
            "Rate limit exceeded",
            resets_at=datetime.now().timestamp() + retry_after,
            retry_after=retry_after,
        )

    async def get_organization_id(self) -> Optional[str]:
        """Get organization UUID from Claude.ai."""
        response = await self._request(
            "GET", "/api/organizations",
            timeout=30.0,
        )

        if response.status_code != 200:
            logger.error(f"Failed to get org ID: {response.status_code}")
            return None

        data = response.json()
        if data and isinstance(data, list):
            # Find org with chat capability
            for org in data:
                if "uuid" in org and "capabilities" in org:
                    caps = org.get("capabilities", [])
                    if "chat" in caps:
                        return org["uuid"]
            # Fallback to first org
            if len(data) > 0 and "uuid" in data[0]:
                return data[0]["uuid"]

        return None

    async def create_conversation(self, model: str = None) -> Optional[str]:
        """
        Create a new chat conversation.

        Args:
            model: Claude model name

        Returns:
            Conversation UUID
        """
        org_uuid = self.org_uuid
        if not org_uuid:
            logger.error("No organization UUID available")
            return None

        url = f"/api/organizations/{org_uuid}/chat_conversations"
        payload = {
            "uuid": str(uuid_lib.uuid4()),
            "name": "Claude Web2 Proxy",
            "include_conversation_preferences": True,
        }

        if model:
            # Don't send model for sonnet-4 (uses default)
            if not model.startswith("claude-sonnet-4"):
                payload["model"] = model

        response = await self._request("POST", url, json_data=payload, timeout=30.0)

        if response.status_code not in (200, 201):
            logger.error(f"Failed to create conversation: {response.status_code} - {await self._extract_error(response)}")
            return None

        data = response.json()
        conv_uuid = data.get("uuid")

        if conv_uuid:
            logger.debug(f"Created conversation: {conv_uuid}")
        else:
            logger.error(f"Conversation created but UUID missing: {data}")

        return conv_uuid

    async def send_message(
        self,
        conv_uuid: str,
        prompt: str,
        model: Optional[str] = None,
        stream: bool = True,
        max_tokens: int = 4096,
        attachments: Optional[List[Dict]] = None,
        files: Optional[List[str]] = None,
        tools: Optional[List[Dict]] = None,
        rendering_mode: str = "messages",
        timezone: str = "UTC",
    ) -> AsyncIterator[str]:
        """
        Send a message to Claude.ai and stream the response.

        Args:
            conv_uuid: Conversation UUID
            prompt: The prompt to send
            model: Claude model name
            stream: Whether to stream the response
            max_tokens: Maximum tokens to generate
            attachments: File attachments
            files: File UUIDs
            tools: Available tools
            rendering_mode: Rendering mode
            timezone: Client timezone

        Yields:
            SSE data lines
        """
        org_uuid = self.org_uuid
        if not org_uuid:
            logger.error("No organization UUID available")
            raise ValueError("No organization UUID")

        url = f"/api/organizations/{org_uuid}/chat_conversations/{conv_uuid}/completion"

        payload = {
            "prompt": prompt,
            "max_tokens_to_sample": max_tokens,
            "attachments": attachments or [],
            "files": files or [],
            "rendering_mode": rendering_mode,
            "timezone": timezone,
        }

        # Use parent_message_uuid if provided (for session resume)
        if hasattr(self, '_last_message_uuid') and self._last_message_uuid:
            payload["parent_message_uuid"] = self._last_message_uuid

        if model and not model.startswith("claude-sonnet-4"):
            payload["model"] = model

        if tools:
            payload["tools"] = tools

        logger.debug(f"Sending message to Claude.ai (conv: {conv_uuid}, model: {model})")

        response = await self._request(
            "POST", url,
            json_data=payload,
            stream=True,
            conv_uuid=conv_uuid,
            timeout=300.0,  # 5 minute timeout for long generations
        )

        if response.status_code != 200:
            error_msg = await self._extract_error(response)
            logger.error(f"Claude.ai error: {response.status_code} - {error_msg}")

            # Re-raise auth errors
            if response.status_code in (401, 403):
                raise ClaudeAuthInvalidError(error_msg)

            # For other errors, yield an error event
            error_event = {
                "type": "error",
                "error": {
                    "type": "api_error",
                    "message": error_msg,
                }
            }
            yield f"data: {json.dumps(error_event)}\n\n"
            return

        # Track last message UUID for session resume
        async for chunk in response.aiter_text():
            # Extract message UUID from response if present
            if chunk.startswith("data: ") and "message" in chunk:
                try:
                    data = json.loads(chunk[6:])
                    if isinstance(data, dict) and data.get("type") == "message":
                        msg_uuid = data.get("uuid")
                        if msg_uuid:
                            self._last_message_uuid = msg_uuid
                            logger.debug(f"Tracked message UUID: {msg_uuid}")
                except (json.JSONDecodeError, KeyError):
                    pass
            yield chunk

    async def send_tool_result(
        self,
        conv_uuid: str,
        tool_use_id: str,
        tool_name: str,
        tool_result: str,
    ):
        """
        Send a tool result back to Claude.ai and resume the SSE stream.

        Uses Claude's /tool_result endpoint with the proper payload format
        matching the clove reference implementation.

        Args:
            conv_uuid: Conversation UUID
            tool_use_id: The tool use ID from the tool call
            tool_name: The name of the tool that was called
            tool_result: The result string from the tool

        Returns:
            SSE stream (async iterator of text chunks) for the continuation
        """
        org_uuid = self.org_uuid
        if not org_uuid:
            logger.error("No organization UUID available for tool result")
            return

        url = f"/api/organizations/{org_uuid}/chat_conversations/{conv_uuid}/tool_result"

        # Payload format matching clove/claude reference project
        # content should be array of content blocks in the format [{"type": "text", "text": "..."}]
        # Handle various input formats:
        if isinstance(tool_result, str):
            content = [{"type": "text", "text": tool_result}]
        elif isinstance(tool_result, list):
            content = []
            for item in tool_result:
                if isinstance(item, str):
                    content.append({"type": "text", "text": item})
                elif isinstance(item, dict) and "text" in item:
                    # Already a content block, use as-is
                    content.append(item)
                elif isinstance(item, dict) and "type" in item:
                    content.append(item)
                else:
                    content.append({"type": "text", "text": str(item)})
        else:
            content = [{"type": "text", "text": str(tool_result)}]

        payload = {
            "tool_use_id": tool_use_id,
            "content": content,
            "is_error": False,
        }

        response = await self._request(
            "POST", url,
            json_data=payload,
            stream=True,  # Stream the response for SSE continuation
            timeout=300.0,  # 5 minute timeout for long generations
            conv_uuid=conv_uuid,
        )

        if response.status_code != 200:
            error_msg = await self._extract_error(response)
            logger.error(f"Tool result failed: {response.status_code} - {error_msg}")
            # Return an error SSE event
            error_event = {
                "type": "error",
                "error": {
                    "type": "api_error",
                    "message": error_msg,
                }
            }
            yield f"data: {json.dumps(error_event)}\n\n"
            return

        # Return the SSE stream
        async for chunk in response.aiter_text():
            yield chunk

    async def delete_conversation(self, conv_uuid: str) -> bool:
        """
        Delete a chat conversation.

        Args:
            conv_uuid: Conversation UUID to delete

        Returns:
            True if successful
        """
        org_uuid = self.org_uuid
        if not org_uuid:
            return False

        url = f"/api/organizations/{org_uuid}/chat_conversations/{conv_uuid}"

        try:
            response = await self._request(
                "DELETE", url,
                json_data={"uuid": conv_uuid},
                timeout=10.0,
                conv_uuid=conv_uuid,
            )
            return response.status_code in (200, 204)
        except Exception as e:
            logger.debug(f"Failed to delete conversation {conv_uuid}: {e}")
            return False

    async def upload_file(
        self,
        file_data: bytes,
        filename: str,
        content_type: str,
    ) -> Optional[str]:
        """
        Upload a file to Claude.ai.

        Args:
            file_data: Raw file bytes
            filename: Filename
            content_type: MIME type

        Returns:
            File UUID if successful, None otherwise
        """
        org_uuid = self.org_uuid
        if not org_uuid:
            logger.error("No organization UUID available")
            return None

        url = f"/api/{org_uuid}/upload"

        from io import BytesIO

        try:
            async with get_client(impersonate="chrome", proxy=self.proxy) as client:
                headers = await build_claude_headers(
                    self.account.get_cookie() or "",
                    claude_url=settings.claude_ai_url,
                )

                if self.account.oauth_token:
                    headers["Authorization"] = f"Bearer {self.account.oauth_token.access_token}"
                    headers.pop("Cookie", None)

                files = {"file": (filename, BytesIO(file_data), content_type)}

                response = await client.post(
                    f"{self.BASE_URL}{url}",
                    files=files,
                    headers=headers,
                )

                if response.status_code != 200:
                    logger.error(f"File upload failed: {response.status_code}")
                    return None

                data = response.json()
                file_uuid = data.get("file_uuid")
                logger.debug(f"Uploaded file {filename}: {file_uuid}")
                return file_uuid

        except Exception as e:
            logger.error(f"Error uploading file {filename}: {e}")
            return None

    async def get_account_info(self) -> Dict[str, Any]:
        """Get account information and capabilities."""
        response = await self._request(
            "GET", "/api/account?statsig_hashing_algorithm=djb2",
            timeout=15.0,
        )

        if response.status_code != 200:
            return {}

        return response.json()

    async def update_user_setting(self, key: str, value: Any) -> bool:
        """Update a user setting on Claude.ai."""
        url = f"/api/account?statsig_hashing_algorithm=djb2"

        payload = {
            "settings": {
                key: value,
                "has_started_claudeai_onboarding": True,
                "has_finished_claudeai_onboarding": True,
            }
        }

        try:
            response = await self._request(
                "PUT", url,
                json_data=payload,
                timeout=15.0,
            )
            return response.status_code in (200, 202)
        except Exception as e:
            logger.debug(f"Failed to update setting {key}: {e}")
            return False