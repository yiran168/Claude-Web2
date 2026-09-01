"""Models listing endpoint with dynamic fetching."""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Dict, Any

from app.services.account_manager import AccountManager
from app.clients.claude_web import ClaudeWebClient
from app.core.exceptions import NoAccountsAvailableError
from app.core.account import Account

router = APIRouter()

# Fallback model list used when no accounts are available or fetching fails
DEFAULT_MODELS: List[Dict[str, Any]] = [
    # Claude 4 (latest)
    {"id": "claude-sonnet-4-20250514", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-opus-4-20250514", "object": "model", "owned_by": "anthropic"},
    # Claude 3.7
    {"id": "claude-3-7-sonnet-20250219", "object": "model", "owned_by": "anthropic"},
    # Claude 3.5
    {"id": "claude-3-5-sonnet-20241022", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-5-haiku-20241022", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-5-sonnet-20240620", "object": "model", "owned_by": "anthropic"},
    # Claude 3
    {"id": "claude-3-opus-20240229", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-sonnet-20240229", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-haiku-20240307", "object": "model", "owned_by": "anthropic"},
    # Legacy
    {"id": "claude-2.1", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-2", "object": "model", "owned_by": "anthropic"},
    # Aliases
    {"id": "claude", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-sonnet-4", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-opus-4", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-7-sonnet", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-5-sonnet", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-5-haiku", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-opus", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-sonnet", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-haiku", "object": "model", "owned_by": "anthropic"},
]


async def get_models() -> List[Dict[str, Any]]:
    """
    Fetch available models from Claude.ai using configured accounts.
    
    Returns:
        List of model dicts with 'id', 'object', and 'owned_by' keys.
        Falls back to DEFAULT_MODELS if no accounts are available or fetching fails.
    """
    account_manager = AccountManager()
    
    try:
        # Try to get an account to fetch models dynamically
        account = await account_manager.get_available_account()
        if account:
            client = ClaudeWebClient(account=account)
            models = await client.fetch_available_models()
            if models:
                return models
    except (NoAccountsAvailableError, Exception) as e:
        # Fall back to default models
        pass
    
    return DEFAULT_MODELS


@router.get("/models", tags=["Models"])
async def list_models():
    """List available models. Fetches dynamically from Claude.ai when accounts are configured."""
    account_manager = AccountManager()
    
    try:
        account = await account_manager.get_available_account()
        if account:
            client = ClaudeWebClient(account=account)
            models = await client.fetch_available_models()
            if models:
                return JSONResponse(
                    status_code=200,
                    content={
                        "object": "list",
                        "data": models,
                    }
                )
    except Exception:
        pass
    
    # Fall back to default models
    return JSONResponse(
        status_code=200,
        content={
            "object": "list",
            "data": DEFAULT_MODELS,
        }
    )