"""Application package."""

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from loguru import logger
import os

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

    # Mount static files for frontend
    static_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
    if os.path.exists(static_dir):
        app.mount("/static", StaticFiles(directory=static_dir), name="static")

    # Include routers
    app.include_router(health.router, prefix="/health", tags=["Health"])
    app.include_router(chat.router, prefix="/v1", tags=["Chat"])
    app.include_router(models_route.router, prefix="/v1", tags=["Models"])
    app.include_router(admin.router, prefix="/admin", tags=["Admin"])

    # Frontend routes
    @app.get("/", response_class=FileResponse)
    async def frontend():
        """Serve the main frontend page."""
        return FileResponse(os.path.join(static_dir, "index.html"))

    return app


app = create_app()