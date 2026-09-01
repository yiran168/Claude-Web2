"""
Gunicorn configuration for Claude-Web2.

This file provides an alternative to uvicorn for production deployments.
"""

bind = "0.0.0.0:8000"
workers = 1
worker_class = "uvicorn.workers.UvicornWorker"
worker_connections = 100
timeout = 300
keepalive = 60
pidfile = "/app/data/gunicorn.pid"
errorlog = "/app/data/gunicorn_error.log"
accesslog = "/app/data/gunicorn_access.log"
loglevel = "info"