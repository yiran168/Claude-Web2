FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gcc \
    g++ \
    make \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and source code first (needed for poetry install to find packages)
COPY pyproject.toml README.md ./
COPY app/ ./app/
RUN pip install --no-cache-dir poetry && poetry config virtualenvs.create false && poetry install --only=main

# Copy remaining source files
COPY env.py ./
COPY gunicorn_conf.py ./
COPY .env.example ./

# Copy frontend static files
COPY static/ ./static/

# Create data directory
RUN mkdir -p /app/data

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health/health || exit 1

# Run with uvicorn
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]