# PaperDesk Task Runner

default:
    @just --list

# Setup environments
setup:
    uv sync --all-groups

# Run tests
test:
    uv run pytest

# Lint and type check
lint:
    uv run ruff check paperdesk sidecar tests
    uv run pyright sidecar

# Run sidecar server in development
dev-sidecar:
    uv run python -m sidecar

