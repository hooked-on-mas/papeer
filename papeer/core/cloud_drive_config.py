"""Developer-owned desktop OAuth configuration; never collected by the settings UI.

The official build uses a public client ID with PKCE. An optional developer configuration can
support older clients, but a value shipped to a native client cannot remain confidential.
User tokens are separate and stay protected by cloud_drive_auth's DPAPI storage.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import sys

from papeer.core.fileio import atomic_write_text

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_CONFIG = Path(__file__).parent / "assets" / "google-oauth.json"
BUNDLE_NAME = "google-desktop-oauth.json"
BUNDLE_CONFIG = Path("build") / BUNDLE_NAME
CONFIG_FILE_ENV = "PAPEER_GOOGLE_OAUTH_CONFIG_FILE"
CLIENT_ID_ENV = "PAPEER_GOOGLE_DESKTOP_CLIENT_ID"
CLIENT_SECRET_ENV = "PAPEER_GOOGLE_DESKTOP_CLIENT_SECRET"


@dataclass(frozen=True)
class DesktopOAuth:
    client_id: str
    client_secret: str = field(default="", repr=False)

    @property
    def configured(self) -> bool:
        return bool(self.client_id)


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text("utf-8-sig"))
    except (OSError, ValueError):
        raise ValueError("Google接続のビルド設定を読み込めません。開発者向け設定を確認してください。") from None
    if not isinstance(value, dict) or "web" in value:
        raise ValueError("Google接続にはデスクトップアプリ用の資格情報を指定してください。")
    result = value.get("installed", value)
    if not isinstance(result, dict):
        raise ValueError("Google接続のビルド設定の形式が不正です。")
    return result


def desktop_oauth() -> DesktopOAuth:
    public = _read(PUBLIC_CONFIG)
    private: dict = {}
    custom = os.environ.get(CONFIG_FILE_ENV, "").strip()
    if custom:
        private = _read(Path(custom).expanduser())
    elif getattr(sys, "frozen", False):
        bundled = Path(sys._MEIPASS) / BUNDLE_NAME  # pyright: ignore[reportAttributeAccessIssue]
        if bundled.is_file():
            private = _read(bundled)
    client_id = os.environ.get(CLIENT_ID_ENV, "").strip() or private.get("client_id") or public.get("desktop_client_id", "")
    secret = os.environ.get(CLIENT_SECRET_ENV, "").strip() or private.get("client_secret", "")
    if not isinstance(client_id, str) or (client_id and not re.fullmatch(r"[A-Za-z0-9_-]+\.apps\.googleusercontent\.com", client_id)):
        raise ValueError("Google接続のデスクトップ用クライアントIDが不正です。")
    if not isinstance(secret, str) or len(secret) > 2048 or any(c in secret for c in "\r\n\x00"):
        raise ValueError("Google接続のビルド設定が不正です。")
    return DesktopOAuth(client_id, secret)


def setup_status() -> dict:
    try:
        configured = desktop_oauth().configured
        return {"configured": configured, "setup_error": None if configured else
                "このビルドにはGoogle接続の設定が含まれていません。接続対応版に更新してください。"}
    except ValueError:
        return {"configured": False, "setup_error": "Google接続の設定を読み込めません。接続対応版に更新してください。"}


def write_bundle(root: Path = ROOT) -> bool:
    config = desktop_oauth()
    target = root / BUNDLE_CONFIG
    target.parent.mkdir(parents=True, exist_ok=True)
    value = {"client_id": config.client_id}
    if config.client_secret:
        value["client_secret"] = config.client_secret
    atomic_write_text(target, json.dumps(value))
    try:
        target.chmod(0o600)
    except OSError:
        pass  # On Windows the file inherits the developer's folder ACL.
    return config.configured


def main() -> int:
    parser = argparse.ArgumentParser(description="Google接続の開発・配布用設定。資格情報の内容は表示しません。")
    parser.add_argument("--write-bundle", action="store_true")
    parser.add_argument("--require-configured", action="store_true")
    args = parser.parse_args()
    try:
        configured = desktop_oauth().configured
        if args.require_configured and not configured:
            raise ValueError("公式配布にはGoogle接続のビルド設定が必要です。docs/google-drive-web.mdを確認してください。")
        if args.write_bundle:
            write_bundle()
        print("Google接続設定: 組み込み可能" if configured else "Google接続設定: 未設定（このビルドでは新規接続は無効）")
        return 0
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
