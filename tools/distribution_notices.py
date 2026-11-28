"""Collect installed dependency notices for a sidecar, without network access.

Called by sidecar.spec. Verify a built or installed folder with
`python tools/distribution_notices.py --check dist/sidecar`.
Missing license texts or versions fail the build instead of producing a partial notice bundle.
"""
from __future__ import annotations

import argparse
import hashlib
from importlib import metadata
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from tools.license_inventory import host_target, python_inventory
PREFIXES = ("license", "licence", "copying", "notice", "copyright", "authors")
PDFIUM_LICENSES = {"abseil.txt", "agg23.txt", "fast_float.txt", "freetype.txt", "icu.txt", "lcms.txt",
                   "libjpeg_turbo.ijg", "libjpeg_turbo.md", "libopenjpeg.txt", "libpng.txt", "libtiff.txt",
                   "llvm-libc.txt", "pdfium-binaries.txt", "pdfium.txt", "simdutf.txt", "zlib.txt"}


def license_file(path: Path) -> bool:
    return (any(part.lower() in ("licenses", "build_licenses") for part in path.parts)
            or path.name.lower().startswith(PREFIXES))


def fallback(name: str, version: str, root: Path) -> Path:
    # These wheels/crates omit the upstream text. Copies are pinned to upstream revisions,
    # recorded in adjacent .source files. Re-check them when the package version changes.
    key = f"{name}-{version}"
    if name.startswith("winrt-") and version == "3.2.1":
        key = "pywinrt-3.2.1"
    elif name.startswith("unic-") and version == "0.9.0":
        key = "unic-char-property-0.9.0"
    elif (name, version) in (("webview2-com-macros", "0.8.1"), ("webview2-com-sys", "0.38.2")):
        key = "webview2-com-0.38.2"
    return root / "tools" / "distribution_licenses" / key


def collect_python(root: Path) -> tuple[list[dict], dict[str, bytes]]:
    target = host_target()
    if target is None:
        raise ValueError("Unsupported release platform")
    # Include build dependencies conservatively: setuptools and PyInstaller runtime hooks
    # can enter the executable even though they are absent from the application's runtime graph.
    rows = [row for row in python_inventory(root, target) if {"runtime", "build"} & set(row["scopes"])]
    entries, files = [], {}
    for row in rows:
        name, version = row["name"], row["version"]
        dist = metadata.distribution(name)
        if dist.version != version:
            raise ValueError(f"Installed {name} {dist.version} differs from locked {version}")
        prefix = f"python/{name}-{version}"
        paths = []
        for item in dist.files or ():
            if license_file(Path(str(item))):
                source = Path(dist.locate_file(item))
                if source.is_file():
                    # Retain the complete license directory, including nested PDFium build notices.
                    dest = f"{prefix}/{item.as_posix()}"
                    files[dest] = source.read_bytes()
                    paths.append(dest)
        if not paths:
            extra = fallback(name, version, root)
            for source in sorted(extra.glob("*")):
                if source.is_file():
                    dest = f"{prefix}/{source.name}"
                    files[dest] = source.read_bytes()
                    if not source.name.endswith(".source"):
                        paths.append(dest)
        if not paths:
            raise ValueError(f"No license text for Python package {name} {version}")
        # METADATA retains upstream author/copyright/project links and the license declaration.
        files[f"{prefix}/METADATA"] = (dist.read_text("METADATA") or "").encode("utf-8")
        if name == "pymupdf":
            files[f"{prefix}/AGPL-3.0.txt"] = (root / "LICENSE").read_bytes()
            paths.append(f"{prefix}/AGPL-3.0.txt")
            # The wheel's COPYING is only a one-line dual-license declaration. MuPDF's
            # embedded fonts and native dependencies also need their upstream notices.
            mupdf = root / "tools/distribution_licenses" / f"mupdf-{version}"
            if not (mupdf / "sources.json").is_file():
                raise ValueError(f"Re-audit native MuPDF licenses for PyMuPDF {version}")
            for source in sorted(mupdf.rglob("*")):
                if source.is_file():
                    dest = f"{prefix}/native/{source.relative_to(mupdf).as_posix()}"
                    files[dest] = source.read_bytes()
                    paths.append(dest)
        entries.append({"ecosystem": "python", "name": name, "version": version, "licenses": paths,
                        "source": f"https://pypi.org/project/{name}/{version}/#files"})
    return entries, files


def collect_rust(root: Path) -> tuple[list[dict], dict[str, bytes]]:
    target = host_target()
    if target is None:
        raise ValueError("Unsupported release platform")
    cwd = root / "frontend" / "src-tauri"
    data = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--offline", "--locked", "--format-version", "1", "--filter-platform", target.rust],
        cwd=cwd, encoding="utf-8"))
    # Cargo metadata includes some inactive optional dependencies. cargo tree applies feature resolution.
    tree = subprocess.check_output(["cargo", "tree", "--offline", "--locked", "--target", target.rust,
                                    "--prefix", "none", "--format", "{p}"], cwd=cwd, encoding="utf-8")
    reached = {match.groups() for line in tree.splitlines() if (match := re.match(r"([^ ]+) v([^ ]+)", line))}
    entries, files = [], {}
    for package in sorted(data["packages"], key=lambda p: (p["name"], p["version"])):
        name, version = package["name"], package["version"]
        if package["id"] in data["workspace_members"] or (name, version) not in reached:
            continue
        directory = Path(package["manifest_path"]).parent
        prefix = f"rust/{name}-{version}"
        sources = [path for path in directory.rglob("*")
                   if path.is_file() and license_file(path.relative_to(directory))]
        if package.get("license_file"):
            sources.append(directory / package["license_file"])
        paths = []
        for source in sorted(set(sources)):
            dest = f"{prefix}/{source.relative_to(directory).as_posix()}"
            files[dest] = source.read_bytes()
            paths.append(dest)
        if not paths:
            for source in sorted(fallback(name, version, root).glob("*")):
                if source.is_file():
                    dest = f"{prefix}/{source.name}"
                    files[dest] = source.read_bytes()
                    if not source.name.endswith(".source"):
                        paths.append(dest)
        if not paths:
            raise ValueError(f"No license text for Rust crate {name} {version}")
        files[f"{prefix}/Cargo.toml"] = Path(package["manifest_path"]).read_bytes()
        entries.append({"ecosystem": "rust", "name": name, "version": version,
                        "license": package.get("license"), "licenses": paths,
                        "source": f"https://crates.io/api/v1/crates/{name}/{version}/download"})
    return entries, files


def generate(root: Path = ROOT) -> Path:
    """Build a fresh notice directory; never reuse stale files from an earlier dependency graph."""
    entries, files = collect_python(root)
    rust_entries, rust_files = collect_rust(root)
    entries.extend(rust_entries)
    files.update(rust_files)
    files["AGPL-3.0.txt"] = (root / "LICENSE").read_bytes()
    python_license = next((path for path in (Path(sys.base_prefix) / "LICENSE.txt",
                                             Path(sys.base_prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "LICENSE.txt")
                           if path.is_file()), None)
    if python_license is None:
        python_license = root / "tools/distribution_licenses" / f"python-{sys.version_info.major}.{sys.version_info.minor}" / "LICENSE.txt"
    files["python-runtime/LICENSE.txt"] = python_license.read_bytes()
    files["python-runtime/VERSION.txt"] = (sys.version + "\n").encode()
    files["SOURCE.md"] = (root / "tools/distribution_licenses/SOURCE.md").read_bytes()
    files["README.txt"] = (
        "Papeer third-party notices\n\n"
        "Papeer is licensed under AGPL-3.0-or-later and comes without warranty.\n"
        "See AGPL-3.0.txt and SOURCE.md for terms and corresponding source instructions.\n"
        "Python, Rust and their bundled dependencies retain their own licenses in this directory.\n"
        "manifest.json records exact versions, source download URLs, and every notice's SHA-256.\n"
        "Build-only crates are included conservatively; inclusion is not proof of linking.\n"
        "This software is based in part on the work of the Independent JPEG Group.\n"
        "Portions of this software are copyright the FreeType Project (www.freetype.org).\n"
        "The frontend includes its own third-party notices and font sources.\n"
    ).encode()
    manifest = {"schemaVersion": 1, "target": host_target().name, "packages": entries,
                "files": {name: hashlib.sha256(content).hexdigest() for name, content in sorted(files.items())}}
    files["manifest.json"] = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode()
    (root / "build").mkdir(exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix="distribution-notices-", dir=root / "build"))
    for name, content in files.items():
        dest = output / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
    check(output, direct=True)
    return output


def check(sidecar: Path, *, direct: bool = False) -> None:
    directory = sidecar if direct else sidecar / "_internal" / "licenses"
    manifest = json.loads((directory / "manifest.json").read_text("utf-8"))
    if manifest.get("schemaVersion") != 1 or not manifest.get("packages"):
        raise ValueError("Missing distribution notice manifest")
    for name, expected in manifest["files"].items():
        path = (directory / name).resolve()
        if not path.is_relative_to(directory.resolve()) or not path.is_file():
            raise ValueError(f"Missing/invalid notice: {name}")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Changed notice: {name}")
    for required in ("AGPL-3.0.txt", "SOURCE.md", "README.txt", "python-runtime/LICENSE.txt"):
        if required not in manifest["files"]:
            raise ValueError(f"Missing required notice: {required}")
    pdfium = {Path(name).name for name in manifest["files"] if "/BUILD_LICENSES/" in name}
    if not PDFIUM_LICENSES <= pdfium:
        raise ValueError(f"Missing PDFium licenses: {sorted(PDFIUM_LICENSES - pdfium)}")
    for package in manifest["packages"]:
        if not package["licenses"] or any(name not in manifest["files"] for name in package["licenses"]):
            raise ValueError(f"Missing license for {package['name']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", type=Path, required=True, metavar="SIDECAR_FOLDER")
    args = parser.parse_args()
    try:
        check(args.check)
    except (OSError, ValueError, KeyError) as error:
        print(f"Distribution notices: {error}", file=sys.stderr)
        return 1
    print(f"Distribution notices verified: {args.check}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
