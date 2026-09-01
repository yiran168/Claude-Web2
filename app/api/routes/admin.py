"""Admin API routes for account and system management."""

from typing import List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from datetime import datetime

from app.services.account_manager import account_manager
from app.services.session_manager import session_manager
from app.core.account import AuthType, AccountStatusEnum
from app.config import settings

router = APIRouter()


@router.get("/accounts", tags=["Admin - Accounts"])
async def list_accounts():
    """List all accounts with their status."""
    accounts = await account_manager.list_accounts()

    return JSONResponse(
        status_code=200,
        content={
            "accounts": [
                {
                    "display_name": acc.display_name,
                    "auth_type": acc.auth_type.value,
                    "organization_uuid": acc.organization_uuid,
                    "capabilities": acc.capabilities,
                    "status": acc.status.value,
                    "is_pro": acc.is_pro,
                    "is_rate_limited": acc.is_rate_limited,
                    "rate_limit_reset": acc.rate_limit_reset.isoformat() if acc.rate_limit_reset else None,
                    "last_used": acc.last_used.isoformat() if acc.last_used else None,
                }
                for acc in accounts
            ],
            "stats": account_manager.get_stats(),
        }
    )


@router.post("/accounts/add", tags=["Admin - Accounts"])
async def add_account(
    auth_type: str = "session_key",
    session_key: Optional[str] = None,
    cookie_value: Optional[str] = None,
    oauth_token: Optional[dict] = None,
):
    """Add a new account."""
    from app.core.account import OAuthToken

    try:
        auth_enum = AuthType(auth_type)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid auth_type. Must be one of: {[e.value for e in AuthType]}"
        )

    if auth_enum == AuthType.SESSION_KEY and not session_key:
        raise HTTPException(status_code=400, detail="session_key is required")

    if auth_enum == AuthType.COOKIE and not cookie_value:
        raise HTTPException(status_code=400, detail="cookie_value is required")

    if auth_enum == AuthType.OAUTH and not oauth_token:
        raise HTTPException(status_code=400, detail="oauth_token is required")

    try:
        token = None
        if oauth_token:
            token = OAuthToken.from_dict(oauth_token)

        account = await account_manager.add_account(
            identifier=f"{auth_type}_{hash(session_key or cookie_value or '') % 10000}",
            auth_type=auth_enum,
            session_key=session_key,
            cookie_value=cookie_value,
            oauth_token=token,
        )

        return JSONResponse(
            status_code=200,
            content={
                "status": "added",
                "account": account.display_name,
            }
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/accounts/remove", tags=["Admin - Accounts"])
async def remove_account(identifier: str):
    """Remove an account by identifier."""
    success = await account_manager.remove_account(identifier)
    if not success:
        raise HTTPException(status_code=404, detail=f"Account not found: {identifier}")

    return JSONResponse(
        status_code=200,
        content={"status": "removed", "account": identifier}
    )


@router.post("/accounts/{identifier}/reset", tags=["Admin - Accounts"])
async def reset_account(identifier: str):
    """Reset account status to valid."""
    account = await account_manager.get_account(identifier)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account not found: {identifier}")

    account.mark_valid()
    return JSONResponse(
        status_code=200,
        content={"status": "reset", "account": identifier}
    )


@router.get("/status", tags=["Admin - Status"])
async def system_status():
    """Get comprehensive system status."""
    account_stats = account_manager.get_stats()
    session_stats = session_manager.get_stats()

    return JSONResponse(
        status_code=200,
        content={
            "timestamp": datetime.utcnow().isoformat(),
            "accounts": account_stats,
            "sessions": session_stats,
            "config": {
                "proxy": "configured" if settings.proxy else "not set",
                "retry_attempts": settings.retry_attempts,
                "session_timeout": settings.session_timeout,
            }
        }
    )