"""Fail distribution when the freshly generated host inventory is incomplete; retain it with the release."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.license_inventory import SCHEMA_VERSION, Target, host_target, stale_sources


def check(inventory: dict, root: Path, target: Target) -> list[str]:
    problems = []
    if inventory.get("schemaVersion") != SCHEMA_VERSION:
        problems.append("unsupported inventory schema")
    if not str(inventory.get("target", "")).startswith(target.label + ";"):
        problems.append("inventory belongs to a different platform")
    problems.extend(f"stale source: {name}" for name in stale_sources(inventory, root))
    packages = inventory.get("packages", {})
    for ecosystem in ("python", "javascript", "rust"):
        rows = packages.get(ecosystem)
        if not isinstance(rows, list) or not rows:
            problems.append(f"{ecosystem}: missing package inventory")
            continue
        for row in rows:
            scopes = row.get("scopes", [])
            relevant = ("runtime" in scopes if ecosystem == "python" else
                        "production" in scopes and row.get("targetRelevant") if ecosystem == "javascript" else
                        "normal-graph" in scopes)
            if not relevant:
                continue
            label = f"{ecosystem}: {row.get('name')} {row.get('version')}"
            license_name = row.get("license")
            if not isinstance(license_name, str) or license_name.strip().lower() in ("", "unknown"):
                problems.append(label + ": missing license declaration")
            evidence = row.get("licenseEvidence")
            # The inventory abbreviates external Cargo registry paths with "~/".
            if not isinstance(evidence, str) or not (root / Path(evidence).expanduser()).is_file():
                problems.append(label + ": missing local license evidence")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Copy the checked inventory here for distribution")
    args = parser.parse_args(argv)
    target = host_target()
    if target is None:
        print("Unsupported release platform", file=sys.stderr)
        return 1
    source = ROOT / target.inventory
    try:
        inventory = json.loads(source.read_text("utf-8"))
        problems = check(inventory, ROOT, target)
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        print(f"Cannot check release inventory: {exc}", file=sys.stderr)
        return 1
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, args.output / f"dependency-license-inventory.{target.name}.json")
    print(f"Release inventory checked: {target.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
