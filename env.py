"""Environment configuration loader."""

from pathlib import Path
from dotenv import load_dotenv

# Load .env file
env_path = Path(__file__).parent / ".env"
load_dotenv(env_path)

# Re-export settings
from app.config import settings

__all__ = ["settings"]