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

# Run the end-to-end tests on the real app window (frontend/e2e, README「E2E テスト」)
# デバッグ版の papeer.exe を作り（変更がなければすぐ終わる）、sidecar・Vite・代役 API とアプリを一時フォルダーに隔離して起動し、WebView2 を CDP で操作する
# 実際の AI は呼ばない。開発用の sidecar（8000）・Vite（1420）が動いていれば止めてから実行する（例: just e2e --repeat 3、just e2e library）
[working-directory: 'frontend']
e2e *args:
    $env:TAURI_CONFIG = '{"bundle":{"externalBin":[]}}'; cargo build --manifest-path src-tauri/Cargo.toml
    node e2e/run.ts {{ args }}

# Lint and type check (README「テストと lint」)
# ruff check only: ruff format is not applied (pyproject.toml [tool.ruff.lint])
# pyright checks papeer and sidecar as pyproject.toml [tool.pyright] lists them (a few files are left out there)
lint: lint-backend lint-frontend

lint-backend:
    uv run ruff check papeer sidecar tests tools
    uv run pyright

# ESLint checks the rules of React hooks only (frontend/eslint.config.js); tsc the types
[working-directory: 'frontend']
lint-frontend:
    pnpm typecheck
    pnpm lint

# Run clippy on the Tauri app as CI does (README「テストと lint」)
# sidecar の exe がなくても通るよう TAURI_CONFIG で externalBin を外す。変数はこの行の PowerShell の中だけで効き、終われば消える
# （付けたまま just build するとインストーラーに sidecar が入らないため、シェルには残さない）
[working-directory: 'frontend/src-tauri']
clippy:
    $env:TAURI_CONFIG = '{"bundle":{"externalBin":[]}}'; cargo clippy --release --all-targets -- -D warnings

# Regenerate the API schema and the frontend's types from the sidecar (tools/export_openapi.py, README「API の型」)
# frontend/openapi.json を app.openapi() から書き出し、openapi-typescript で frontend/src/api/schema.d.ts を作り直す
# API のモデルやルートを変えたら実行して両方をコミットする（一致は tests/test_openapi_schema.py で検査する）
gen-api:
    uv run python tools/export_openapi.py
    pnpm --dir frontend gen-api

# Set the app version in every manifest and lock file (tools/bump_version.py, README「リリース」)
# 全ファイルの版を書き換え、CHANGELOG の [Unreleased] をその版の節に移す（例: just bump 0.3.0）
bump version:
    uv run python tools/bump_version.py {{ version }}

# Regenerate the license inventory of every locked dependency (tools/license_inventory.py, README「依存ライブラリ」)
# 依存を変えたら実行して台帳もコミットする。ロックファイルとインストール済みの情報だけを読み、ネットワークは使わない
# ライセンス台帳を作り直す。`just licenses check` は記録したロックファイル等のハッシュが今と一致するかだけを確かめる
licenses mode="":
    uv run python tools/license_inventory.py {{ if mode == "check" { "--check" } else if mode == "" { "" } else { error("just licenses か just licenses check を指定してください") } }}

# Check the locked dependencies against vulnerability advisories (tools/audit_dependencies.py, README「依存ライブラリ」)
# 依存の名前と版だけを外部のアドバイザリ DB に問い合わせる（ライブラリや設定などのデータは送らない）
# 既知の脆弱性を調べる（pip-audit・pnpm audit・cargo audit）。一部だけなら just audit python rust
audit *ecosystems:
    uv run python tools/audit_dependencies.py {{ ecosystems }}

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

# Build sidecar binary, smoke-test it, and only then place it where Tauri's externalBin expects it
# 同梱ソースのハッシュは PyInstaller の前に計算して build/ に置き、コピーが成功してから sidecar-sources.txt にする
# （ビルド中にソースを編集しても、その編集を含まない sidecar が「最新」と記録されないように）
build-sidecar:
    uv run python -m papeer.core.code_version code-version.txt
    uv run python -m papeer.core.code_version --record-bundle build/sidecar-sources.pending
    uv run --group build pyinstaller --noconfirm sidecar.spec
    uv run python tools/smoke_sidecar.py
    uv run python -c "import shutil; shutil.copy2('dist/sidecar-x86_64-pc-windows-msvc.exe', 'frontend/src-tauri/')"
    uv run python -c "import os; os.replace('build/sidecar-sources.pending', 'sidecar-sources.txt')"

# Smoke-test the built sidecar exe before packaging it (tools/smoke_sidecar.py, README「ビルド」)
# データ・LOCALAPPDATA・TEMP を一時フォルダーにして起動する。実際の AI は呼ばない（翻訳はスクリプトが 127.0.0.1 で動かす代役 API で行う）
# `--source` は exe の代わりに python -m sidecar を試し、`--keep` は一時フォルダー（データ・ログ）を残す
# dist の sidecar exe を試す（/health の版、認証、プロンプト、PDF の取り込みと翻訳、/shutdown と _MEI* の後始末）
smoke-sidecar *args:
    uv run python tools/smoke_sidecar.py {{ args }}

# Build everything
build: build-sidecar build-app

# 同梱する sidecar が現在のソースから作られたかを確かめる（code-version.txt と、ビルド時に記録した同梱ソース・依存関係の内容ハッシュの一致）
check-sidecar:
    uv run python -m papeer.core.code_version --check code-version.txt sidecar-sources.txt

[working-directory: 'frontend']
build-app: check-sidecar
    pnpm tauri build

# Remove build, dist, output and tmp (repository root only)
# `just clean` は対象と容量の一覧を表示するだけ。`just clean yes` で削除する
clean confirm="":
    uv run python tools/clean.py {{ if confirm == "yes" { "--yes" } else { "" } }}
