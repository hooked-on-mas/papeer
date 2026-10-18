"""Keep Papeer's version in step across Python, the frontend and Tauri, and cut CHANGELOG sections.

  uv run python tools/bump_version.py 0.3.0           # rewrite every version, open [0.3.0] in CHANGELOG.md
  uv run python tools/bump_version.py --check         # every file carries the same version (exit 1 if not)
  uv run python tools/bump_version.py --check 0.3.0   # ... and it is 0.3.0 (the release workflow checks the tag)
  uv run python tools/bump_version.py --notes 0.3.0   # print the CHANGELOG section of 0.3.0 (release notes)

Only this project's own version is touched: the lock files keep every dependency as it is.
Because of that, the lock file hashes in the license inventories
(docs/dependency-license-inventory*.json, one per platform, tools/license_inventory.py) are refreshed in
the same write in each inventory that matched the files before the bump; a stale one is left alone.
The version is plain MAJOR.MINOR.PATCH. Pre-release and build suffixes are refused because
the MSI installer (WiX) takes numbers only and PEP 440 would spell them differently from
Cargo and npm, so the four manifests could no longer agree character for character.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    # `python tools/bump_version.py` puts only tools/ on the path.
    sys.path.append(str(ROOT))

from papeer.core.fileio import atomic_write_bytes  # noqa: E402
from tools.license_inventory import inventory_files, refresh_source_hashes, stale_sources  # noqa: E402

CHANGELOG = "CHANGELOG.md"

# MSI ProductVersion is major.minor.build with limits 255.255.65535 (Tauri maps PATCH to build).
SEMVER = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")
MSI_LIMITS = (255, 255, 65535)

_V = r'"(?P<v>[^"\n]*)"'


@dataclass(frozen=True)
class Spot:
    """One place that carries the version: a file and a pattern matching it exactly once."""
    path: str
    pattern: re.Pattern[str]
    json_key: bool = False  # Also confirm the match is the top-level "version" of the JSON document.


def _section(header: str) -> str:
    # `version = "..."` inside a TOML table, before the next table header.
    return rf"^{re.escape(header)}\n(?:(?:[^\[\n][^\n]*)?\n)*?version = {_V}$"


def _lock(name: str) -> str:
    # The project's own entry in Cargo.lock / uv.lock (dependencies have their own [[package]] entries).
    return rf'^\[\[package\]\]\nname = "{name}"\nversion = {_V}$'


SPOTS = (
    Spot("pyproject.toml", re.compile(_section("[project]"), re.M)),
    Spot("papeer/__init__.py", re.compile(rf"^__version__ = {_V}$", re.M)),
    Spot("frontend/package.json", re.compile(rf'^  "version": {_V},?$', re.M), json_key=True),
    Spot("frontend/src-tauri/tauri.conf.json", re.compile(rf'^  "version": {_V},?$', re.M), json_key=True),
    Spot("frontend/src-tauri/Cargo.toml", re.compile(_section("[package]"), re.M)),
    Spot("frontend/src-tauri/Cargo.lock", re.compile(_lock("papeer"), re.M)),
    Spot("uv.lock", re.compile(_lock("papeer"), re.M)),
    # Generated from the sidecar (FastAPI version=papeer.__version__); kept in step so it need not be rebuilt.
    Spot("frontend/openapi.json", re.compile(rf'^  "info": \{{\n    "title": "[^"\n]*",\n    "version": {_V}$', re.M)),
)


class VersionError(Exception):
    pass


def parse_version(value: str, where: str = "") -> tuple[int, int, int]:
    """(major, minor, patch); where names the file the value came from, for the error message."""
    where = f"{where} の" if where else ""
    match = SEMVER.fullmatch(value)
    if not match:
        raise VersionError(f"{where}版 {value!r} は MAJOR.MINOR.PATCH の形式ではありません（例: 0.3.0。"
                           "-beta などの接尾辞は MSI が受け付けないため使えません）。")
    parts = (int(match[1]), int(match[2]), int(match[3]))
    if any(part > limit for part, limit in zip(parts, MSI_LIMITS)):
        raise VersionError(f"{where}版 {value} は MSI の上限 (255.255.65535) を超えています。")
    return parts


def _read_text(path: Path, name: str) -> str:
    try:
        # Bytes in, bytes out: line endings and encoding stay exactly as they are.
        return path.read_bytes().decode("utf-8")
    except FileNotFoundError:
        raise VersionError(f"{name} がありません。") from None


def _read(root: Path, spot: Spot) -> tuple[str, re.Match[str]]:
    text = _read_text(root / spot.path, spot.path)
    matches = list(spot.pattern.finditer(text))
    if len(matches) != 1:
        raise VersionError(f"{spot.path} で版の記載を 1 か所に特定できません（{len(matches)} か所）。")
    if spot.json_key and json.loads(text).get("version") != matches[0]["v"]:
        raise VersionError(f"{spot.path} の最上位の \"version\" を特定できません。")
    return text, matches[0]


def read_versions(root: Path = ROOT) -> dict[str, str]:
    """{file: version} for every spot."""
    return {spot.path: _read(root, spot)[1]["v"] for spot in SPOTS}


def check(root: Path = ROOT, expected: str | None = None, out=None) -> bool:
    out = sys.stdout if out is None else out
    versions = read_versions(root)
    values = set(versions.values())
    if len(values) == 1 and (expected is None or values == {expected}):
        print(f"版はすべて {values.pop()} です。", file=out)
        return True
    print("版が一致しません" + (f"（期待値 {expected}）" if expected else "") + ":", file=out)
    for path, value in versions.items():
        print(f"  {value:<12} {path}", file=out)
    return False


_UNRELEASED = re.compile(r"^## \[Unreleased\][^\n]*\n", re.M)
_HEADING = re.compile(r"^## ", re.M)
_UNRELEASED_LINK = re.compile(
    r"^\[Unreleased\]: (?P<base>https://github\.com/[^/\s]+/[^/\s]+)/"
    r"(?:compare/v(?P<prev>\d+\.\d+\.\d+)\.\.\.HEAD|commits/\S+)$", re.M)


def cut_changelog(text: str, version: str, today: date) -> str:
    """Move everything under [Unreleased] into a new [version] section and update the link list."""
    if "\r\n" in text:  # An editor saved it with CRLF: work in LF and give it back as it was.
        return cut_changelog(text.replace("\r\n", "\n"), version, today).replace("\n", "\r\n")
    heading = _UNRELEASED.search(text)
    if not heading:
        raise VersionError(f"{CHANGELOG} に「## [Unreleased]」の見出しがありません。")
    if re.search(rf"^## \[{re.escape(version)}\]", text, re.M):
        raise VersionError(f"{CHANGELOG} にはすでに [{version}] の節があります。")
    following = _HEADING.search(text, heading.end())
    body_end = following.start() if following else len(text)
    link = _UNRELEASED_LINK.search(text)
    if link:
        body_end = min(body_end, link.start())
    if not text[heading.end():body_end].strip():
        raise VersionError(f"{CHANGELOG} の [Unreleased] が空です。今回の変更を書いてから版を上げてください。")
    text = text[:heading.end()] + f"\n## [{version}] - {today.isoformat()}\n" + text[heading.end():]
    link = _UNRELEASED_LINK.search(text)
    if link:
        base, prev = link["base"], link["prev"]
        released = f"{base}/compare/v{prev}...v{version}" if prev else f"{base}/releases/tag/v{version}"
        text = (text[:link.start()] + f"[Unreleased]: {base}/compare/v{version}...HEAD\n"
                + f"[{version}]: {released}" + text[link.end():])
    return text


def release_notes(text: str, version: str) -> str:
    text = text.replace("\r\n", "\n")
    heading = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n", text, re.M)
    if not heading:
        raise VersionError(f"{CHANGELOG} に [{version}] の節がありません。")
    following = _HEADING.search(text, heading.end())
    end = following.start() if following else len(text)
    link = _UNRELEASED_LINK.search(text, heading.end())
    if link:
        end = min(end, link.start())
    # Drop the trailing link reference definitions of the last section.
    notes = re.sub(r"(?:^\[[^\]\n]+\]: \S+\n?)+\Z", "", text[heading.end():end].strip() + "\n", flags=re.M)
    if not notes.strip():
        raise VersionError(f"{CHANGELOG} の [{version}] が空です。")
    return notes.strip() + "\n"


def _write_all(writes: list[tuple[Path, str, str]]) -> None:
    """Replace each file atomically; if one fails, put the ones already written back as they were."""
    done: list[tuple[Path, str]] = []
    for path, original, text in writes:
        try:
            atomic_write_bytes(path, text.encode("utf-8"))
        except OSError as error:
            for written, before in reversed(done):
                atomic_write_bytes(written, before.encode("utf-8"))
            raise VersionError(f"{path.name} を書き込めませんでした（{error}）。"
                               "書き換えたファイルは元に戻しました。") from error
        done.append((path, original))


def bump(version: str, root: Path = ROOT, today: date | None = None, out=None) -> None:
    """Write version into every spot and cut the CHANGELOG. Nothing is written unless all of it succeeds."""
    out = sys.stdout if out is None else out
    new = parse_version(version)
    reads = [(spot, *_read(root, spot)) for spot in SPOTS]
    current = max(parse_version(match["v"], spot.path) for spot, _, match in reads)
    if new < current:
        raise VersionError(f"版を {'.'.join(map(str, current))} から {version} に下げることはできません。")
    if all(match["v"] == version for _, _, match in reads):
        raise VersionError(f"版はすでにすべて {version} です。")
    changelog = root / CHANGELOG
    log_text = _read_text(changelog, CHANGELOG)
    # (path, original text, new text)
    writes = [(changelog, log_text, cut_changelog(log_text, version, today or date.today()))]
    changed: dict[str, bytes] = {}
    for spot, text, match in reads:
        if match["v"] != version:
            new_text = text[:match.start("v")] + version + text[match.end("v"):]
            writes.append((root / spot.path, text, new_text))
            changed[spot.path] = new_text.encode("utf-8")
    stale_inventories, refreshed = [], []
    for relative in inventory_files(root):
        inventory = root / relative
        inventory_text = _read_text(inventory, relative)
        # Dependencies stay as they are, so a current inventory stays current: only its hashes move.
        if stale_sources(json.loads(inventory_text), root):
            stale_inventories.append(relative)
        else:
            writes.append((inventory, inventory_text, refresh_source_hashes(inventory_text, changed)))
            refreshed.append(relative)
    _write_all(writes)
    for spot, _, match in reads:
        print(f"  {match['v']:<8} -> {version}  {spot.path}", file=out)
    for relative in stale_inventories:
        print(f"注意: {relative} が依存の変更に追いついていません。just licenses（macOS・Linux のものは CI の "
              "licenses ジョブ）で作り直してください。", file=out)
    for relative in refreshed:
        print(f"  {relative} のロックファイルのハッシュを更新しました。", file=out)
    print(f"{CHANGELOG} の [Unreleased] を [{version}] にしました。内容を確認してからコミットし、"
          f"タグ v{version} を付けてください。", file=out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version", nargs="?", help="新しい版 (MAJOR.MINOR.PATCH)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="全ファイルの版が一致するか（版を渡すとその版か）を確かめる")
    mode.add_argument("--notes", action="store_true", help="CHANGELOG.md から指定の版の節を出力する")
    parser.add_argument("--output", type=Path, help="--notes の出力先 (UTF-8)。省略時は標準出力")
    args = parser.parse_args(argv)
    try:
        if args.check:
            return 0 if check(expected=args.version) else 1
        if not args.version:
            parser.error("版を指定してください（例: just bump 0.3.0）")
        if args.notes:
            notes = release_notes(_read_text(ROOT / CHANGELOG, CHANGELOG), args.version)
            if args.output:
                args.output.write_bytes(notes.encode("utf-8"))
            else:
                sys.stdout.write(notes)
            return 0
        bump(args.version)
    except VersionError as error:
        print(f"エラー: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
