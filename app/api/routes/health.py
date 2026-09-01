"""Health check and model listing endpoints."""

from datetime import datetime
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.services.account_manager import account_manager
from app.services.session_manager import session_manager
from app.services.tool_call_manager import tool_call_manager

router = APIRouter()


@router.get("/", tags=["Health"])
@router.get("/health", tags=["Health"])
async def health_check():
    """Health check endpoint."""
    account_stats = account_manager.get_stats()
    session_stats = session_manager.get_stats()
    tool_stats = tool_call_manager.get_stats()

    return JSONResponse(
        status_code=200,
        content={
            "status": "ok",
            "timestamp": datetime.utcnow().isoformat(),
            "accounts": account_stats,
            "sessions": session_stats,
            "tool_calls": tool_stats,
        }
    )