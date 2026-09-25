# PaperDesk Task Runner

# Windows では Git Bash の sh が PATH にないことが多いため PowerShell を使う
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

default:
    @just --list

# Setup environments
setup: setup-backend setup-frontend

setup-backend:
    uv sync --all-groups

[working-directory: 'frontend']
setup-frontend:
    pnpm install

# Run tests
test: test-backend test-frontend

test-backend:
    uv run pytest

[working-directory: 'frontend']
test-frontend:
    pnpm tsc --noEmit

# Lint and type check
lint: lint-backend lint-frontend

lint-backend:
    uv run ruff check paperdesk sidecar tests tools
    uv run pyright sidecar

[working-directory: 'frontend']
lint-frontend:
    pnpm tsc --noEmit

# Run sidecar server in development
dev-sidecar:
    uv run python -m sidecar

# Run frontend in development
[working-directory: 'frontend']
dev-frontend:
    pnpm tauri dev

# Build sidecar binary and place it where Tauri's externalBin expects it
build-sidecar:
    uv run python -m paperdesk.core.code_version code-version.txt
    uv run pyinstaller --noconfirm sidecar.spec
    uv run python -c "import shutil; shutil.copy2('dist/sidecar-x86_64-pc-windows-msvc.exe', 'frontend/src-tauri/')"

# Build everything
build: build-sidecar build-app

[working-directory: 'frontend']
build-app:
    pnpm tauri build
