"""Application configuration using Pydantic Settings."""

import os
import json
from pathlib import Path
from typing import Optional, List, Union

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, HttpUrl


class Settings(BaseSettings):
    """Application settings with environment variable support.

    Priority: environment variables > default values
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_ignore_empty=True,
        extra="ignore",
    )

    # Server settings
    host: str = Field(default="0.0.0.0", env="HOST")
    port: int = Field(default=8088, env="PORT")

    # Data storage
    data_folder: Path = Field(
        default=Path("/tmp/claude-web2"),
        env="DATA_FOLDER",
        description="Folder path for storing SQLite DB and data",
    )

    # Authentication (comma-separated for multiple accounts)
    sessions: List[str] = Field(
        default_factory=list,
        env="SESSIONS",
        description="Comma-separated list of Claude.ai session keys (sk-ant-sid01-*)",
    )
    cookies: List[str] = Field(
        default_factory=list,
        env="COOKIES",
        description="Comma-separated list of Claude.ai cookie strings",
    )
    oauth_tokens: List[str] = Field(
        default_factory=list,
        env="OAUTH_TOKENS",
        description="JSON array of OAuth token objects",
    )

    # Claude endpoints
    claude_ai_url: str = Field(
        default="https://claude.ai",
        env="CLAUDE_AI_URL",
        description="Base URL for Claude.ai",
    )
    claude_api_baseurl: str = Field(
        default="https://api.anthropic.com",
        env="CLAUDE_API_BASEURL",
        description="Base URL for Anthropic API (if using API key)",
    )

    # Claude OAuth settings
    oauth_client_id: str = Field(
        default="9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        env="OAUTH_CLIENT_ID",
        description="OAuth client ID for Claude authentication",
    )
    oauth_token_url: str = Field(
        default="https://console.anthropic.com/v1/oauth/token",
        env="OAUTH_TOKEN_URL",
        description="OAuth token exchange endpoint URL",
    )

    # API key for authenticating requests to this proxy
    api_key: Optional[str] = Field(
        default=None,
        env="API_KEY",
        description="API key for authenticating requests to this proxy",
    )

    # Proxy settings
    proxy: Optional[str] = Field(
        default=None,
        env="PROXY",
        description="HTTP proxy URL (Claude.ai blocks non-residential IPs)",
    )

    # Retry settings
    retry_attempts: int = Field(default=3, env="RETRY_ATTEMPTS")
    retry_interval: int = Field(default=1, env="RETRY_INTERVAL", description="Base retry delay in seconds")

    # Session settings
    session_timeout: int = Field(
        default=300,
        env="SESSION_TIMEOUT",
        description="Session idle timeout in seconds",
    )
    max_sessions_per_account: int = Field(
        default=3,
        env="MAX_SESSIONS_PER_ACCOUNT",
        description="Max concurrent sessions per account",
    )

    # Account management
    account_check_interval: int = Field(
        default=60,
        env="ACCOUNT_CHECK_INTERVAL",
        description="Interval for account health checks",
    )

    # Logging
    log_level: str = Field(default="INFO", env="LOG_LEVEL")
    log_to_file: bool = Field(default=False, env="LOG_TO_FILE")
    log_file_path: str = Field(
        default="logs/app.log",
        env="LOG_FILE_PATH",
    )

    @property
    def database_path(self) -> Path:
        """Get database path."""
        return self.data_folder / "claude_web2.db"

    def model_post_init(self, __context) -> None:
        """Post-init processing."""
        if self.cookies and isinstance(self.cookies, str):
            self.cookies = [c.strip() for c in self.cookies.split(",") if c.strip()]
        if self.sessions and isinstance(self.sessions, str):
            self.sessions = [s.strip() for s in self.sessions.split(",") if s.strip()]


settings = Settings()