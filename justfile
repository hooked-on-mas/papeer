# Papeer Task Runner

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

# node:test のテスト (frontend/tests) は Node 22.18 以上の型除去で .ts を直接実行する
[working-directory: 'frontend']
test-frontend:
    pnpm typecheck
    pnpm test

# Lint and type check
lint: lint-backend lint-frontend

lint-backend:
    uv run ruff check papeer sidecar tests tools
    uv run pyright sidecar

[working-directory: 'frontend']
lint-frontend:
    pnpm typecheck

# Run sidecar server in development
# 前回の本アプリの sidecar がポート 8000 に残っていれば止めてから起動する
# 認証トークンはデバッグ版 Tauri (src-tauri/src/lib.rs の DEV_TOKEN) と同じ固定値を使う
dev-sidecar:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/stop_stale_dev.ps1 -Port 8000
    $env:PAPEER_TOKEN = 'dev_token'; uv run python -m sidecar

# Run frontend in development
# 前回の Vite (1420) とデバッグ版のウィンドウが残っていれば止めてから起動する
[working-directory: 'frontend']
dev-frontend:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File ../tools/stop_stale_dev.ps1 -Port 1420 -ExePath frontend/src-tauri/target/debug/papeer.exe
    pnpm tauri dev

# Build sidecar binary and place it where Tauri's externalBin expects it
build-sidecar:
    uv run python -m papeer.core.code_version code-version.txt
    uv run pyinstaller --noconfirm sidecar.spec
    uv run python -c "import shutil; shutil.copy2('dist/sidecar-x86_64-pc-windows-msvc.exe', 'frontend/src-tauri/')"
    uv run python -m papeer.core.code_version --record-bundle sidecar-sources.txt

# Build everything
build: build-sidecar build-app

# 同梱する sidecar が現在のソースから作られたかを確かめる（code-version.txt と、ビルド時に記録した同梱ソース・依存関係の内容ハッシュの一致）
check-sidecar:
    uv run python -m papeer.core.code_version --check code-version.txt sidecar-sources.txt

[working-directory: 'frontend']
build-app: check-sidecar
    pnpm tauri build
