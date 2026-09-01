"""Models listing endpoint."""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()

# Available models
MODELS = [
    {"id": "claude-3-5-sonnet-20241022", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-5-haiku-20241022", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-opus-20240229", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-sonnet-20240229", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-haiku-20240307", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-2.1", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-2", "object": "model", "owned_by": "anthropic"},
    # Aliases
    {"id": "claude", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-5-sonnet", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-5-haiku", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-opus", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-sonnet", "object": "model", "owned_by": "anthropic"},
    {"id": "claude-3-haiku", "object": "model", "owned_by": "anthropic"},
]


@router.get("/models", tags=["Models"])
async def list_models():
    """List available models."""
    return JSONResponse(
        status_code=200,
        content={
            "object": "list",
            "data": MODELS,
        }
    )