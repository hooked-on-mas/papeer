"""Generate docs/dependency-license-inventory.json: every locked dependency and its declared license.

  uv run python tools/license_inventory.py          # regenerate the inventory (just licenses)
  uv run python tools/license_inventory.py --check  # the lock files still match it (exit 1 if not)

Nothing is fetched from the network. The dependency graphs come from the lock files, the licenses
from what is installed on this machine:

  Python      uv.lock + the METADATA of the wheels in .venv          (uv sync --all-groups)
  JavaScript  pnpm-lock.yaml + package.json in frontend/node_modules (pnpm install), and `pnpm licenses list`
  Rust        `cargo tree` / `cargo metadata --offline --locked` (the crates cached by a previous cargo build)

A package that is not installed here (an optional binary for another OS/CPU, a wheel for another
platform) is recorded with license "unknown". The target is Windows x64, so run it on Windows.

The inventory records the sha256 of the lock files it was made from (sourceFiles);
tests/test_license_inventory.py fails when they no longer match, so a dependency change must come
with a regenerated inventory. `just bump` changes only the project's own version in those files and
refreshes the hashes itself (refresh_source_hashes) when the inventory was current before the bump.
"""
from __future__ import annotations

import argparse
from collections import Counter, deque
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = "docs/dependency-license-inventory.json"
SCHEMA_VERSION = 2
PROJECT = "papeer"
RUST_TARGET = "x86_64-pc-windows-msvc"
# The lock files the dependency graphs are read from, in the order they are listed in the inventory.
# Only the lock files: each one also records the project's direct dependencies (uv.lock and
# Cargo.lock in the project's own entry, pnpm-lock.yaml in its importers), so a dependency change
# always reaches them, while unrelated manifest edits (tool settings, scripts, build profiles) do not.
SOURCE_FILES = (
    "uv.lock",
    "frontend/pnpm-lock.yaml",
    "frontend/src-tauri/Cargo.lock",
)
# frontend/public/pdfjs was copied by hand from this pdfjs-dist release; it does not follow the lock file.
PDFJS_ASSETS_FROM = "6.3.289"
FONTS = "papeer/core/assets/fonts"


class InventoryError(Exception):
    pass


# --- source file hashes ------------------------------------------------------------------------

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_hashes(root: Path = ROOT) -> list[dict]:
    """[{path, sha256}] of SOURCE_FILES as they are now (raw bytes; .gitattributes keeps them LF)."""
    rows = []
    for path in SOURCE_FILES:
        try:
            rows.append({"path": path, "sha256": sha256((root / path).read_bytes())})
        except FileNotFoundError:
            raise InventoryError(f"{path} がありません。") from None
    return rows


def stale_sources(inventory: dict, root: Path = ROOT) -> list[str]:
    """The source files whose content differs from what the inventory was made from (or that are missing)."""
    recorded = {row.get("path"): row.get("sha256") for row in inventory.get("sourceFiles", [])
                if isinstance(row, dict)}
    stale = []
    for path in SOURCE_FILES:
        try:
            digest = sha256((root / path).read_bytes())
        except FileNotFoundError:
            digest = None
        if digest is None or recorded.get(path) != digest:
            stale.append(path)
    return stale


def dumps(inventory: dict) -> str:
    return json.dumps(inventory, ensure_ascii=False, indent=2) + "\n"


def refresh_source_hashes(text: str, contents: dict[str, bytes]) -> str:
    """The inventory text with the hashes of the given files replaced (for `just bump`)."""
    inventory = json.loads(text)
    for row in inventory["sourceFiles"]:
        if row["path"] in contents:
            row["sha256"] = sha256(contents[row["path"]])
    return dumps(inventory)


def check(root: Path = ROOT, out=None) -> bool:
    out = sys.stdout if out is None else out
    try:
        inventory = json.loads((root / INVENTORY).read_bytes())
    except FileNotFoundError:
        print(f"{INVENTORY} がありません。just licenses で作成してください。", file=out)
        return False
    stale = stale_sources(inventory, root)
    if not stale:
        print(f"{INVENTORY} はロックファイルと一致しています。", file=out)
        return True
    print(f"{INVENTORY} の作成後に変更されたファイルがあります。just licenses で作り直してください:", file=out)
    for path in stale:
        print(f"  {path}", file=out)
    return False


# --- helpers ------------------------------------------------------------------------------------

def rel(path: Path, root: Path = ROOT) -> str:
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return str(path).replace(str(Path.home()), "~").replace("\\", "/")


def run(command: list[str], cwd: Path) -> str:
    executable = shutil.which(command[0])
    if not executable:
        raise InventoryError(f"{command[0]} が見つかりません。")
    try:
        return subprocess.run([executable, *command[1:]], cwd=cwd, check=True, capture_output=True,
                              encoding="utf-8").stdout
    except subprocess.CalledProcessError as error:
        raise InventoryError(f"{' '.join(command)} が失敗しました:\n{error.stderr.strip()}") from None


def site_packages(root: Path) -> Path:
    path = root / ".venv" / "Lib" / "site-packages"
    if not path.is_dir():
        raise InventoryError(f"{rel(path, root)} がありません。uv sync --all-groups を実行してください。")
    return path


# --- Python -------------------------------------------------------------------------------------

def python_inventory(root: Path = ROOT) -> list[dict]:
    from importlib import metadata

    from packaging.markers import Marker
    from packaging.utils import canonicalize_name

    locked = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    packages = {canonicalize_name(item["name"]): item for item in locked["package"]}
    project = packages[PROJECT]
    dist_info = {}
    for dist in metadata.distributions(path=[str(site_packages(root))]):
        name = dist.metadata.get("Name")
        if name:
            dist_info[canonicalize_name(name)] = dist

    windows_environment = {
        "sys_platform": "win32",
        "os_name": "nt",
        "platform_system": "Windows",
        "platform_machine": "AMD64",
        "platform_python_implementation": "CPython",
        "implementation_name": "cpython",
        "python_version": "3.12",
        "python_full_version": "3.12.0",
    }

    def reachable(roots: list[dict]) -> set[str]:
        seen = set()
        names = set()
        queue = deque(roots)
        while queue:
            dependency = queue.popleft()
            if dependency.get("marker") and not Marker(dependency["marker"]).evaluate(windows_environment):
                continue
            name = canonicalize_name(dependency["name"])
            extras = tuple(sorted(dependency.get("extra", [])))
            if (name, extras) in seen or name not in packages:
                continue
            seen.add((name, extras))
            names.add(name)
            package = packages[name]
            queue.extend(package.get("dependencies", []))
            for extra in extras:
                queue.extend(package.get("optional-dependencies", {}).get(extra, []))
        return names

    groups = project.get("dev-dependencies", {})
    runtime_roots, build_roots, dev_roots = project["dependencies"], groups.get("build", []), groups.get("dev", [])
    direct = {scope: {canonicalize_name(x["name"]) for x in roots}
              for scope, roots in (("runtime", runtime_roots), ("build", build_roots), ("development", dev_roots))}
    reached = {"windows-runtime": reachable(runtime_roots), "build": reachable(build_roots),
               "development": reachable(dev_roots)}

    rows = []
    for name, package in sorted(packages.items()):
        if name == PROJECT:
            continue
        scopes = [scope for scope, names in reached.items() if name in names] or ["other-platform-in-lock"]
        direct_scopes = [scope for scope, names in direct.items() if name in names]
        dist = dist_info.get(name)
        license_text = "unknown"
        evidence = None
        if dist:
            folder = Path(getattr(dist, "_path"))  # The .dist-info folder (PathDistribution has no public name).
            license_text = dist.metadata.get("License-Expression") or dist.metadata.get("License") or "unknown"
            evidence = rel(folder / "METADATA", root)
            # Wheels that declare no license in METADATA: the license files they ship were read by hand.
            if name == "colorama" and license_text == "unknown":
                license_text = "BSD-3-Clause"
                evidence = rel(folder / "licenses" / "LICENSE.txt", root)
            elif name == "pyinstaller-hooks-contrib" and license_text == "unknown":
                license_text = "GPL-2.0-or-later (standard hooks); Apache-2.0 (runtime hooks)"
                evidence = rel(folder / "licenses" / "LICENSE", root)
        rows.append({
            "name": name,
            "version": package["version"],
            "dependencyType": "direct" if direct_scopes else "transitive",
            "directScopes": direct_scopes,
            "scopes": scopes,
            "license": license_text,
            "licenseEvidence": evidence,
            "installedOnAuditMachine": dist is not None,
        })
    return rows


# --- JavaScript ---------------------------------------------------------------------------------

def javascript_inventory(root: Path = ROOT) -> list[dict]:
    import yaml

    frontend = root / "frontend"
    lock = yaml.safe_load((frontend / "pnpm-lock.yaml").read_text(encoding="utf-8"))
    snapshots = lock["snapshots"]
    packages = lock["packages"]
    importer = lock["importers"]["."]

    def reachable(roots: dict) -> set[str]:
        queue = deque(name + "@" + item["version"] for name, item in roots.items())
        seen = set()
        while queue:
            key = queue.popleft()
            if key in seen:
                continue
            if key not in snapshots:
                raise InventoryError(f"pnpm-lock.yaml に {key} の snapshot がありません。")
            seen.add(key)
            snapshot = snapshots[key]
            for group in ("dependencies", "optionalDependencies"):
                queue.extend(name + "@" + version for name, version in snapshot.get(group, {}).items())
        return seen

    production = reachable(importer.get("dependencies", {}))
    development = reachable(importer.get("devDependencies", {}))
    if production | development != set(snapshots):
        raise InventoryError("pnpm-lock.yaml に本番・開発のどちらからも辿れない snapshot があります。")

    node_modules = frontend / "node_modules" / ".pnpm"
    if not node_modules.is_dir():
        raise InventoryError("frontend/node_modules がありません。frontend で pnpm install を実行してください。")
    installed = {}
    paths = list(node_modules.glob("*/node_modules/*/package.json"))
    paths += list(node_modules.glob("*/node_modules/@*/*/package.json"))
    for path in sorted(paths):
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
            key = (manifest["name"], manifest["version"])
            installed.setdefault(key, (manifest, path))
        except (KeyError, ValueError, TypeError):
            continue

    direct_prod = set(importer.get("dependencies", {}))
    direct_dev = set(importer.get("devDependencies", {}))
    rows = []
    for key in sorted(snapshots):
        package_key = key.split("(", 1)[0]
        if package_key not in packages:
            raise InventoryError(f"pnpm-lock.yaml に {package_key} の packages 項目がありません。")
        name, version = package_key.rsplit("@", 1)
        entry = packages[package_key]
        present = installed.get((name, version))
        license_text = "unknown"
        evidence = None
        if present:
            manifest, path = present
            value = manifest.get("license")
            if isinstance(value, str) and value.strip():
                license_text = value.strip()
                evidence = rel(path, root)
            elif name == "khroma":
                # Declares no license in package.json; its license file is MIT.
                license_path = path.parent / "license"
                if license_path.exists() and "MIT License" in license_path.read_text(encoding="utf-8")[:60]:
                    license_text = "MIT"
                    evidence = rel(license_path, root)
        direct_scopes = [scope for scope, names in (("production", direct_prod), ("development", direct_dev))
                         if name in names]
        row = {
            "name": name,
            "version": version,
            "dependencyType": "direct" if direct_scopes else "transitive",
            "directScopes": direct_scopes,
            "scopes": (["production"] if key in production else []) + (["development"] if key in development else []),
            "license": license_text,
            "licenseEvidence": evidence,
            "installedOnAuditMachine": present is not None,
            "lockKey": key,
        }
        platform = {field: entry[field] for field in ("os", "cpu", "libc") if field in entry}
        if platform:
            row["platformRestriction"] = platform
        row["targetRelevant"] = (("os" not in platform or "win32" in platform["os"])
                                 and ("cpu" not in platform or "x64" in platform["cpu"]))
        rows.append(row)
    return rows


def pnpm_licenses_summary(rows: list[dict], root: Path = ROOT) -> dict:
    """Cross-check with `pnpm licenses list --prod`, which reads the installed packages (no network)."""
    data = json.loads(run(["pnpm", "licenses", "list", "--prod", "--json"], root / "frontend"))
    pairs = {(item["name"], version) for values in data.values() for item in values for version in item["versions"]}
    installed_production = {(row["name"], row["version"]) for row in rows
                            if "production" in row["scopes"] and row["installedOnAuditMachine"]}
    return {
        "pnpmLicensesProdGroupedRecords": sum(len(values) for values in data.values()),
        "pnpmLicensesProdNameVersionPairs": len(pairs),
        "installedProductionPairsOmittedByPnpmLicensesCommand": [
            {"name": name, "version": version} for name, version in sorted(installed_production - pairs)
        ],
    }


# --- Rust ---------------------------------------------------------------------------------------

def rust_inventory(root: Path = ROOT) -> list[dict]:
    tauri = root / "frontend" / "src-tauri"

    def cargo_tree(*options: str) -> set[tuple[str, str]]:
        # cargo tree applies the feature resolver per target and dependency kind; the resolve graph of
        # cargo metadata unifies features and lists crates that are never built for the target.
        output = run(["cargo", "tree", "--locked", "--offline", "--target", RUST_TARGET, "--prefix", "none",
                      "--format", "{p}", *options], tauri)
        return {match.groups() for line in output.splitlines() if (match := re.match(r"([^ ]+) v([^ ]+)", line))}

    # The license and manifest of each exact crate (cargo reads them from its local cache).
    meta = json.loads(run(["cargo", "metadata", "--offline", "--locked", "--format-version", "1",
                           "--filter-platform", RUST_TARGET], tauri))
    packages = {(package["name"], package["version"]): package for package in meta["packages"]}
    members = {(package["name"], package["version"]) for package in meta["packages"]
               if package["id"] in meta["workspace_members"]}
    everything = cargo_tree() - members
    normal = cargo_tree("--edges", "normal") - members
    direct_runtime = cargo_tree("--edges", "normal", "--depth", "1") - members
    direct_build = cargo_tree("--edges", "build", "--depth", "1") - members
    rows = []
    for name, version in sorted(everything):
        package = packages.get((name, version))
        if package is None:
            raise InventoryError(f"cargo metadata に {name} {version} がありません。")
        manifest = Path(package["manifest_path"])
        direct_scopes = [scope for scope, pairs in (("runtime", direct_runtime), ("build", direct_build))
                         if (name, version) in pairs]
        rows.append({
            "name": name,
            "version": version,
            "dependencyType": "direct" if direct_scopes else "transitive",
            "directScopes": direct_scopes,
            "scopes": ["normal-graph"] if (name, version) in normal else ["build-only-graph"],
            "license": package.get("license") or "unknown",
            "licenseEvidence": rel(manifest, root),
            "cachedSourceOnAuditMachine": manifest.is_file(),
        })
    return rows


# --- bundled assets -----------------------------------------------------------------------------

def bundled_assets(root: Path = ROOT) -> list[dict]:
    from fontTools.ttLib import TTFont

    font_assets = []
    for filename, license_file in (("SourceHanSerifJP-Regular.otf", "source-han-serif-LICENSE.txt"),
                                   ("SourceHanSansJP-Bold.otf", "source-han-sans-LICENSE.txt")):
        path = root / FONTS / filename
        with TTFont(path) as font:
            version = font["name"].getDebugName(5)
        font_assets.append({
            "name": filename,
            "version": version,
            "license": "OFL-1.1",
            "sha256": sha256(path.read_bytes()),
            "licenseEvidence": f"{FONTS}/{license_file}",
        })

    packages = site_packages(root)
    pdfium_info = json.loads((packages / "pypdfium2_raw" / "version.json").read_text(encoding="utf-8"))
    dist_info = sorted(packages.glob("pypdfium2-*.dist-info"))
    if len(dist_info) != 1:
        raise InventoryError("pypdfium2 の dist-info を 1 つに特定できません。uv sync --all-groups を実行してください。")
    pdfium_licenses = dist_info[0] / "licenses" / "data" / "windows_x64" / "BUILD_LICENSES"
    pdfjs = root / "frontend" / "public" / "pdfjs"
    return [
        {
            "name": "PDFium (via pypdfium2)",
            "version": f"{pdfium_info['major']}.{pdfium_info['minor']}.{pdfium_info['build']}.{pdfium_info['patch']}",
            "license": "BSD-style PDFium license plus bundled third-party licenses",
            "binary": rel(packages / "pypdfium2_raw" / "pdfium.dll", root),
            "licenseEvidence": rel(pdfium_licenses, root),
            "bundledLicenseFiles": sorted(item.name for item in pdfium_licenses.iterdir() if item.is_file()),
        },
        *font_assets,
        {
            "name": f"PDF.js CMaps copied from pdfjs-dist {PDFJS_ASSETS_FROM}",
            "fileCountIncludingLicense": len(list((pdfjs / "cmaps").iterdir())),
            "license": "BSD-style Adobe CMap terms",
            "licenseEvidence": "frontend/public/pdfjs/cmaps/LICENSE",
        },
        {
            "name": f"PDF.js Foxit standard fonts copied from pdfjs-dist {PDFJS_ASSETS_FROM}",
            "fontFileCount": len(list((pdfjs / "standard_fonts").glob("Foxit*.pfb"))),
            "license": "BSD-3-Clause-style terms",
            "licenseEvidence": "frontend/public/pdfjs/standard_fonts/LICENSE_FOXIT",
        },
        {
            "name": f"PDF.js Liberation Sans standard fonts copied from pdfjs-dist {PDFJS_ASSETS_FROM}",
            "fontFileCount": len(list((pdfjs / "standard_fonts").glob("LiberationSans*.ttf"))),
            "license": "GPL-2.0-only with Liberation font exceptions",
            "licenseEvidence": "frontend/public/pdfjs/standard_fonts/LICENSE_LIBERATION",
        },
    ]


# --- the inventory ------------------------------------------------------------------------------

def summarize(groups: dict[str, list[dict]]) -> dict:
    summary = {}
    for ecosystem, rows in groups.items():
        summary[ecosystem] = {
            "rows": len(rows),
            "directRows": sum(row["dependencyType"] == "direct" for row in rows),
            "unknownLicenseRows": sum(row["license"] == "unknown" for row in rows),
            "scopeCounts": dict(Counter(scope for row in rows for scope in row["scopes"])),
        }
    js = groups["javascript"]
    summary["javascript"].update({
        "windowsX64RelevantRows": sum(row["targetRelevant"] for row in js),
        "windowsX64RelevantUnknownLicenseRows": sum(row["targetRelevant"] and row["license"] == "unknown" for row in js),
        "windowsX64ProductionRows": sum(row["targetRelevant"] and "production" in row["scopes"] for row in js),
    })
    return summary


def method(summary: dict, groups: dict[str, list[dict]]) -> list[str]:
    js, py = summary["javascript"], summary["python"]
    production = [row for row in groups["javascript"] if "production" in row["scopes"]]
    missing = [row for row in production if not row["installedOnAuditMachine"]]
    missing_other_platform = sum(not row["targetRelevant"] for row in missing)
    omitted = js["installedProductionPairsOmittedByPnpmLicensesCommand"]
    omitted_licenses = sorted({row["license"] for row in production
                               if {"name": row["name"], "version": row["version"]} in omitted})
    unknown_js_relevant = js["windowsX64RelevantUnknownLicenseRows"]
    unknown_py_windows = sum(row["license"] == "unknown" and row["scopes"] != ["other-platform-in-lock"]
                             for row in groups["python"])
    return [
        "Generated by tools/license_inventory.py (just licenses) from local files only: no registry is queried. "
        "sourceFiles holds the sha256 of the lock files it was made from.",
        f"Python: traverse uv.lock from the {PROJECT} runtime, build, and dev roots; evaluate dependency markers for "
        "CPython 3.12 on Windows; read installed wheel METADATA License-Expression/License fields and inspect named "
        "local LICENSE files where needed.",
        "JavaScript: traverse pnpm-lock.yaml snapshots from production and development importer roots, including "
        "optional edges; read license values from the exact installed package.json. A missing installed package or "
        "license declaration is recorded as unknown.",
        f"pnpm licenses list --prod --json groups by package name: it shows {js['pnpmLicensesProdGroupedRecords']} "
        f"grouped records covering {js['pnpmLicensesProdNameVersionPairs']} exact name/version pairs. The lock "
        f"traversal has {len(production)} production pairs: {len(production) - len(missing)} installed on the "
        f"audit machine and {len(missing)} not installed ({missing_other_platform} of them optional binaries for "
        f"other OS/CPU combinations). The pnpm license command omits {len(omitted)} installed production pairs listed in "
        f"summary; their package.json files were read directly"
        + (f" and declare {', '.join(omitted_licenses)}." if omitted_licenses else "."),
        f"Rust: run cargo tree --locked --offline --target {RUST_TARGET} (and --edges normal; --depth 1 for the "
        "direct dependencies), then read package.license of the exact cached Cargo.toml through cargo metadata "
        "--offline. Other-platform entries in Cargo.lock are excluded.",
        "A production or normal-graph reachability flag means dependency graph inclusion, not proof that code "
        "survives tree shaking or appears in the released binary. Inspect final build artifacts separately before "
        "publication.",
        "License strings are kept as declared upstream, rather than silently normalized to a different SPDX "
        "expression. Unknown means this audit did not verify a license for that locked version.",
        f"Unknown licenses: {js['unknownLicenseRows']} JavaScript rows ({js['productionUnknownLicenseRows']} "
        f"production, {js['developmentUnknownLicenseRows']} development), {unknown_js_relevant} of them relevant "
        f"to Windows x64; {py['unknownLicenseRows']} Python rows, {unknown_py_windows} of them reachable on "
        f"Windows; {summary['rust']['unknownLicenseRows']} Rust rows.",
    ]


def build(root: Path = ROOT, today: date | None = None) -> dict:
    if sys.platform != "win32":
        raise InventoryError("対象は Windows x64 なので Windows 上で実行してください（ライセンスはインストール済みのパッケージから読みます）。")
    groups = {
        "python": python_inventory(root),
        "javascript": javascript_inventory(root),
        "rust": rust_inventory(root),
    }
    summary = summarize(groups)
    js_rows = groups["javascript"]
    summary["javascript"].update(pnpm_licenses_summary(js_rows, root))
    summary["javascript"]["productionUnknownLicenseRows"] = sum(
        "production" in row["scopes"] and row["license"] == "unknown" for row in js_rows)
    summary["javascript"]["developmentUnknownLicenseRows"] = sum(
        "development" in row["scopes"] and row["license"] == "unknown" for row in js_rows)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "auditDate": (today or date.today()).isoformat(),
        "target": f"Windows 11 x64; Python 3.12; Rust {RUST_TARGET}",
        "projectLicense": "AGPL-3.0-or-later (README.md and LICENSE)",
        "method": method(summary, groups),
        "sourceFiles": source_hashes(root),
        "summary": summary,
        "packages": groups,
        "bundledAssets": bundled_assets(root),
    }


def write(inventory: dict, root: Path = ROOT) -> bool:
    """Write the inventory; False (and nothing written) when only auditDate would change."""
    from papeer.core.fileio import atomic_write_bytes

    path = root / INVENTORY
    try:
        previous = json.loads(path.read_bytes())
    except (FileNotFoundError, ValueError):
        previous = None
    if previous is not None and {**previous, "auditDate": inventory["auditDate"]} == inventory:
        return False
    atomic_write_bytes(path, dumps(inventory).encode("utf-8"))
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="台帳がいまのロックファイルから作られたものか確かめる")
    args = parser.parse_args(argv)
    try:
        if args.check:
            return 0 if check() else 1
        inventory = build()
        changed = write(inventory)
    except InventoryError as error:
        print(f"エラー: {error}", file=sys.stderr)
        return 1
    print(f"{INVENTORY} を{'更新しました' if changed else '確認しました（変更なし）'}。")
    for ecosystem, values in inventory["summary"].items():
        print(f"  {ecosystem:<10} {values['rows']:>4} 件（直接 {values['directRows']}、"
              f"ライセンス不明 {values['unknownLicenseRows']}）")
    relevant = inventory["summary"]["javascript"]["windowsX64RelevantUnknownLicenseRows"]
    if relevant:
        print(f"注意: Windows x64 で使う JavaScript パッケージにライセンス不明が {relevant} 件あります。", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if str(ROOT) not in sys.path:
        # `python tools/license_inventory.py` puts only tools/ on the path (write() imports papeer).
        sys.path.append(str(ROOT))
    raise SystemExit(main())
