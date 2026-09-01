"""Claude AI message API endpoint."""

from typing import Optional
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.processors.context import ClaudeAIContext
from app.processors.pipeline import ClaudeAIPipeline
from app.models.claude import MessagesAPIRequest

router = APIRouter()


@router.post("/messages", response_model=None)
async def create_message(
    request: Request,
    messages_request: MessagesAPIRequest,
):
    """
    Claude AI Messages API endpoint.

    Accepts requests in the Claude API format and returns responses
    in the same format.
    """
    context = ClaudeAIContext(
        original_request=request,
        messages_api_request=messages_request,
    )

    context = await ClaudeAIPipeline().process(context)

    if not context.response:
        raise HTTPException(
            status_code=500,
            detail="No response generated"
        )

    return context.response