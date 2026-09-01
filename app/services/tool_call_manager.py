"""Tool call manager for handling assistant tool requests."""

from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta, timezone
import asyncio
import threading

from loguru import logger


class ToolCallState:
    """State of a pending tool call."""

    def __init__(self, tool_use_id: str, session_id: str, message_id: Optional[str] = None):
        self.tool_use_id = tool_use_id
        self.session_id = session_id
        self.message_id = message_id
        self.created_at: datetime = datetime.now(timezone.utc)
        self.completed: bool = False
        self.result: Optional[str] = None

    def age_seconds(self) -> float:
        """Get age in seconds."""
        return (datetime.now(timezone.utc) - self.created_at).total_seconds()

    def to_dict(self) -> dict:
        return {
            "tool_use_id": self.tool_use_id,
            "session_id": self.session_id,
            "message_id": self.message_id,
            "created_at": self.created_at.isoformat(),
            "completed": self.completed,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ToolCallState":
        state = cls(
            tool_use_id=data["tool_use_id"],
            session_id=data["session_id"],
            message_id=data.get("message_id"),
        )
        state.created_at = datetime.fromisoformat(data["created_at"])
        state.completed = data.get("completed", False)
        return state


class ToolCallManager:
    """
    Manages pending tool calls for Claude conversations.

    Tracks tool call requests that need round-trip completion:
    1. Assistant sends tool call to client
    2. Client returns tool results
    3. Manager tracks which session to resume
    """

    _instance: Optional["ToolCallManager"] = None
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

        self._pending: Dict[str, ToolCallState] = {}  # tool_use_id -> state
        self._lock: asyncio.Lock = None
        self._cleanup_task: Optional[asyncio.Task] = None
        self._timeout = 300  # 5 minutes
        self._cleanup_interval = 60  # 1 minute

        logger.info("ToolCallManager initialized")

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def register_tool_call(
        self,
        tool_use_id: str,
        session_id: str,
        message_id: Optional[str] = None,
    ) -> None:
        """Register a pending tool call."""
        state = ToolCallState(tool_use_id, session_id, message_id)
        self._pending[tool_use_id] = state
        logger.debug(
            f"Registered tool call {tool_use_id[:8]}... for session {session_id[:8]}..."
        )

    def complete_tool_call(self, tool_use_id: str) -> bool:
        """Mark a tool call as completed."""
        if tool_use_id in self._pending:
            self._pending[tool_use_id].completed = True
            logger.debug(f"Completed tool call {tool_use_id[:8]}...")
            return True
        return False

    def get_tool_call(self, tool_use_id: str) -> Optional[ToolCallState]:
        """Get a pending tool call state."""
        return self._pending.get(tool_use_id)

    def get_pending_for_session(self, session_id: str) -> List[ToolCallState]:
        """Get all pending tool calls for a session."""
        return [
            state for state in self._pending.values()
            if state.session_id == session_id and not state.completed
        ]

    def is_pending(self, tool_use_id: str) -> bool:
        """Check if a tool call is still pending."""
        state = self._pending.get(tool_use_id)
        if not state:
            return False
        if state.completed:
            return False
        if state.age_seconds() > self._timeout:
            return False
        return True

    async def start_cleanup_task(self) -> None:
        """Start background cleanup for timed-out tool calls."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            logger.info("Started tool call cleanup task")

    async def stop_cleanup_task(self) -> None:
        """Stop background cleanup."""
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None

    async def _cleanup_loop(self) -> None:
        """Background cleanup of timed-out tool calls."""
        while True:
            try:
                now = datetime.now(timezone.utc)
                expired = [
                    tc_id for tc_id, state in self._pending.items()
                    if (now - state.created_at).total_seconds() > self._timeout
                ]
                for tc_id in expired:
                    del self._pending[tc_id]
                    logger.debug(f"Cleaned up timed-out tool call {tc_id[:8]}...")
                if expired:
                    logger.info(f"Cleaned up {len(expired)} expired tool calls")
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in tool call cleanup: {e}")

            await asyncio.sleep(self._cleanup_interval)

    def cleanup_all(self) -> None:
        """Clear all pending tool calls."""
        count = len(self._pending)
        self._pending.clear()
        if count:
            logger.info(f"Cleaned up all {count} tool calls")

    def get_stats(self) -> Dict[str, Any]:
        """Get tool call statistics."""
        pending_count = sum(1 for s in self._pending.values() if not s.completed)
        return {
            "total": len(self._pending),
            "pending": pending_count,
        }


tool_call_manager = ToolCallManager()