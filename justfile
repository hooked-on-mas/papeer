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

# Build sidecar binary and place it where Tauri's externalBin expects it
build-sidecar:
    uv run python -m paperdesk.core.code_version code-version.txt
    uv run pyinstaller --noconfirm sidecar.spec
    uv run python -c "import shutil; shutil.copy2('dist/sidecar-x86_64-pc-windows-msvc.exe', 'frontend/src-tauri/')"

# Build everything
build: build-sidecar
    cd frontend && pnpm tauri build
