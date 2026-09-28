"""Check the locked dependencies against published vulnerability advisories (just audit).

  uv run python tools/audit_dependencies.py                     # Python, JavaScript and Rust
  uv run python tools/audit_dependencies.py python javascript   # only some of them

  python      `uv export` of uv.lock (all groups, with hashes) checked by `uvx pip-audit@PIP_AUDIT`
              (asks the PyPI JSON API about each locked name and version)
  javascript  `pnpm audit` in frontend (sends the locked names and versions to the npm registry)
  rust        `cargo audit` on frontend/src-tauri/Cargo.lock (downloads the RustSec advisory database
              and matches it locally, and reads the crates.io index entries of the crates to spot
              yanked versions; cargo-audit is installed with `cargo install cargo-audit --locked`)

Only dependency names and versions leave this machine: no library, paper, note or setting is read.
Each tool prints its own report. The exit code is 0 only when every selected check ran and found
nothing; a vulnerability, a failed run (for example no network) or a missing tool gives 1.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
ECOSYSTEMS = ("python", "javascript", "rust")
# Pinned so that an audit never runs an unreviewed release of the auditing tool itself; raise it by hand.
PIP_AUDIT = "2.10.1"

# (command, cwd, capture output?) -> (exit code, captured stdout+stderr or "")
Runner = Callable[[list[str], Path, bool], tuple[int, str]]
Which = Callable[[str], "str | None"]


@dataclass(frozen=True)
class Result:
    ecosystem: str
    status: str  # "ok", "found" (vulnerable or failed; see the tool's output) or "missing" (not run)
    message: str


def run(command: list[str], cwd: Path, capture: bool) -> tuple[int, str]:
    if not capture:
        return subprocess.run(command, cwd=cwd).returncode, ""
    done = subprocess.run(command, cwd=cwd, capture_output=True, encoding="utf-8", errors="replace")
    return done.returncode, done.stdout + done.stderr


def _finish(ecosystem: str, code: int, tool: str) -> Result:
    if code == 0:
        return Result(ecosystem, "ok", "既知の脆弱性はありません")
    return Result(ecosystem, "found", f"脆弱性が見つかったか、{tool} の実行に失敗しました（上の出力を確認してください）")


def audit_python(root: Path, runner: Runner, which: Which) -> Result:
    uv, uvx = which("uv"), which("uvx")
    if not uv or not uvx:
        return Result("python", "missing", "uv が見つかりません。https://docs.astral.sh/uv/ から導入してください")
    with tempfile.TemporaryDirectory(prefix="papeer-audit-") as folder:
        requirements = Path(folder) / "requirements.txt"
        # The lock as it is (--frozen): every group, every platform, pinned with hashes.
        code, output = runner([uv, "export", "--frozen", "--all-groups", "--no-emit-project", "--no-header",
                               "--format", "requirements-txt", "--quiet", "--output-file", str(requirements)],
                              root, True)
        if code != 0:
            print(output, file=sys.stderr)
            return Result("python", "found", "uv export に失敗しました（上の出力を確認してください）")
        # --disable-pip: audit the pinned list as is, without installing or resolving anything.
        code, _ = runner([uvx, f"pip-audit@{PIP_AUDIT}", "--requirement", str(requirements), "--disable-pip",
                          "--progress-spinner", "off"], root, False)
    return _finish("python", code, "pip-audit")


def audit_javascript(root: Path, runner: Runner, which: Which) -> Result:
    pnpm = which("pnpm")
    if not pnpm:
        return Result("javascript", "missing",
                      "pnpm が見つかりません。https://pnpm.io/installation の手順で導入してください")
    code, _ = runner([pnpm, "audit"], root / "frontend", False)
    return _finish("javascript", code, "pnpm audit")


def audit_rust(root: Path, runner: Runner, which: Which) -> Result:
    cargo = which("cargo")
    if not cargo:
        return Result("rust", "missing", "cargo が見つかりません。https://www.rust-lang.org/tools/install から Rust を導入してください")
    code, _ = runner([cargo, "audit", "--version"], root, True)
    if code != 0:
        return Result("rust", "missing",
                      "cargo-audit が入っていません。`cargo install cargo-audit --locked` で導入してください（初回は数分かかります）")
    code, _ = runner([cargo, "audit", "--file", str(root / "frontend" / "src-tauri" / "Cargo.lock")], root, False)
    return _finish("rust", code, "cargo audit")


AUDITS = {"python": audit_python, "javascript": audit_javascript, "rust": audit_rust}


def audit(ecosystems: list[str], root: Path = ROOT, runner: Runner = run, which: Which = shutil.which,
          out=None) -> list[Result]:
    out = sys.stdout if out is None else out
    results = []
    for ecosystem in ecosystems:
        print(f"\n== {ecosystem} ==", file=out, flush=True)
        results.append(AUDITS[ecosystem](root, runner, which))
    print("\n結果:", file=out)
    for result in results:
        mark = {"ok": "OK    ", "found": "要確認", "missing": "未実行"}[result.status]  # Same display width.
        print(f"  {mark}  {result.ecosystem:<10} {result.message}", file=out)
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ecosystems", nargs="*", metavar="ECOSYSTEM", help="python / javascript / rust（省略時はすべて）")
    args = parser.parse_args(argv)
    unknown = sorted(set(args.ecosystems) - set(ECOSYSTEMS))
    if unknown:
        parser.error(f"{', '.join(unknown)} は指定できません（python / javascript / rust）")
    selected = [name for name in ECOSYSTEMS if name in args.ecosystems] or list(ECOSYSTEMS)
    results = audit(selected)
    return 0 if all(result.status == "ok" for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
