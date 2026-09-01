"""Application package."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from loguru import logger

from app.api.routes import chat, models as models_route, health, admin
from app.services.account_manager import account_manager
from app.services.session_manager import session_manager
from app.services.tool_call_manager import tool_call_manager
from app.config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle."""
    logger.info("Starting Claude-Web2 proxy...")

    # Ensure data directory exists
    settings.data_folder.mkdir(parents=True, exist_ok=True)

    # Start background tasks
    await session_manager.start_cleanup_task()
    await tool_call_manager.start_cleanup_task()

    yield

    # Shutdown
    logger.info("Shutting down Claude-Web2 proxy...")
    await session_manager.cleanup_all()
    tool_call_manager.cleanup_all()

    logger.info("Claude-Web2 proxy stopped")


def create_app() -> FastAPI:
    """Create the FastAPI application."""
    app = FastAPI(
        title="Claude-Web2",
        description="OpenAI-compatible proxy for Claude.ai",
        version="0.1.0",
        lifespan=lifespan,
    )

    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Include routers
    app.include_router(health.router, prefix="/health", tags=["Health"])
    app.include_router(chat.router, prefix="/v1", tags=["Chat"])
    app.include_router(models_route.router, prefix="/v1", tags=["Models"])
    app.include_router(admin.router, prefix="/admin", tags=["Admin"])

    return app


app = create_app()