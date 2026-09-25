# PaperDesk Task Runner

default:
    @just --list

# Setup environments
setup:
    uv sync --all-groups
    cd frontend && pnpm install

# Run tests
test: test-backend test-frontend

test-backend:
    uv run pytest

test-frontend:
    cd frontend && pnpm tsc --noEmit

# Lint and type check
lint: lint-backend lint-frontend

lint-backend:
    uv run ruff check paperdesk sidecar tests
    uv run pyright sidecar

lint-frontend:
    cd frontend && pnpm tsc --noEmit

# Run sidecar server in development
dev-sidecar:
    uv run python -m sidecar

# Run frontend in development
dev-frontend:
    cd frontend && pnpm tauri dev

# Build sidecar
build-sidecar:
    uv run pyinstaller sidecar.spec

# Build everything
build: build-sidecar
    cd frontend && pnpm tauri build
