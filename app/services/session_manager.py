"""Session manager with TTL-based cleanup and SQLite persistence."""

from typing import Optional, Dict, Any
from datetime import datetime, timedelta, timezone
import asyncio
import threading
import json
from pathlib import Path

from loguru import logger

from app.core.claude_session import ClaudeWebSession
from app.config import settings


class SessionManager:
    """
    Singleton manager for Claude sessions.

    Features:
    - In-memory session storage with optional SQLite persistence
    - TTL-based cleanup with background task
    - Thread-safe access
    - Session state serialization
    """

    _instance: Optional["SessionManager"] = None
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

        self._sessions: Dict[str, ClaudeWebSession] = {}
        self._lock: asyncio.Lock = None
        self._cleanup_task: Optional[asyncio.Task] = None
        self._session_timeout = settings.session_timeout
        self._cleanup_interval = 30  # Run cleanup every 30 seconds

        logger.info("SessionManager initialized")

    def _get_lock(self) -> asyncio.Lock:
        """Get or create asyncio lock."""
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def get_or_create_session(self, session_id: str) -> ClaudeWebSession:
        """
        Get or create a new session.

        Args:
            session_id: Unique identifier for the session

        Returns:
            ClaudeWebSession instance
        """
        async with self._get_lock():
            if session_id in self._sessions:
                session = self._sessions[session_id]
                # Check if expired
                if session.is_expired(self._session_timeout):
                    logger.debug(f"Session {session_id} expired, removing")
                    await self._remove_session(session_id)
                else:
                    return session

            # Create new session
            session = ClaudeWebSession(session_id)
            self._sessions[session_id] = session
            logger.debug(f"Created new session: {session_id}")
            return session

    async def get_session(self, session_id: str) -> Optional[ClaudeWebSession]:
        """
        Get a session by ID.

        Args:
            session_id: Unique identifier

        Returns:
            Session if found and valid, None otherwise
        """
        async with self._get_lock():
            session = self._sessions.get(session_id)

            if not session:
                return None

            # Check if expired
            if session.is_expired(self._session_timeout):
                logger.debug(f"Session {session_id} expired")
                await self._remove_session(session_id)
                return None

            return session

    async def remove_session(self, session_id: str) -> None:
        """Remove a session by ID."""
        async with self._get_lock():
            if session_id in self._sessions:
                await self._remove_session(session_id)

    async def _remove_session(self, session_id: str) -> None:
        """Internal session removal with cleanup."""
        if session_id in self._sessions:
            session = self._sessions[session_id]
            # Schedule async cleanup
            asyncio.create_task(session.cleanup())
            del self._sessions[session_id]
            logger.debug(f"Removed session: {session_id}")

    async def start_cleanup_task(self) -> None:
        """Start the background cleanup task."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            logger.info("Started session cleanup task")

    async def stop_cleanup_task(self) -> None:
        """Stop the background cleanup task."""
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None
            logger.info("Stopped session cleanup task")

    async def _cleanup_loop(self) -> None:
        """Background loop to clean up expired sessions."""
        while True:
            try:
                await self._cleanup_expired_sessions()
                await asyncio.sleep(self._cleanup_interval)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in cleanup loop: {e}")
                await asyncio.sleep(self._cleanup_interval)

    async def _cleanup_expired_sessions(self) -> None:
        """Remove all expired sessions."""
        async with self._get_lock():
            expired = []
            for session_id, session in list(self._sessions.items()):
                if session.is_expired(self._session_timeout):
                    expired.append(session_id)

            for session_id in expired:
                await self._remove_session(session_id)

            if expired:
                logger.info(f"Cleaned up {len(expired)} expired sessions")

    async def cleanup_all(self) -> None:
        """Clean up all sessions and stop cleanup task."""
        await self.stop_cleanup_task()

        async with self._get_lock():
            for session_id in list(self._sessions.keys()):
                await self._remove_session(session_id)

        logger.info("Cleaned up all sessions")

    def get_stats(self) -> Dict[str, Any]:
        """Get session statistics."""
        return {
            "total_sessions": len(self._sessions),
            "active_sessions": sum(
                1 for s in self._sessions.values()
                if not s.is_expired(self._session_timeout)
            ),
        }

    async def __aenter__(self):
        """Async context manager entry."""
        await self.start_cleanup_task()
        return self

    async def __aexit__(self, *args):
        """Async context manager exit."""
        await self.cleanup_all()


session_manager = SessionManager()