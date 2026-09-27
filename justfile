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

# Set the app version in every manifest and lock file (tools/bump_version.py, README「リリース」)
# 全ファイルの版を書き換え、CHANGELOG の [Unreleased] をその版の節に移す（例: just bump 0.3.0）
bump version:
    uv run python tools/bump_version.py {{ version }}

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
    uv run --group build pyinstaller --noconfirm sidecar.spec
    uv run python -c "import shutil; shutil.copy2('dist/sidecar-x86_64-pc-windows-msvc.exe', 'frontend/src-tauri/')"

# Build everything
build: build-sidecar build-app

[working-directory: 'frontend']
build-app:
    pnpm tauri build

# Remove build, dist, output and tmp (repository root only)
# `just clean` は対象と容量の一覧を表示するだけ。`just clean yes` で削除する
clean confirm="":
    uv run python tools/clean.py {{ if confirm == "yes" { "--yes" } else { "" } }}
