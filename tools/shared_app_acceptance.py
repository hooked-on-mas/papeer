"""Seed/validate the implementation acceptance ledger against the reviewed Markdown plan.

Existing evidence is retained when seeding. No test is automatically marked accepted.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "docs/shared-app-acceptance.json"
LAYERS = ("ui", "command", "interaction", "render", "undo", "durability", "reload", "otherHost", "desktop", "web", "device", "oldCodeRemoval")


def requirements():
    plan = (ROOT / "docs/shared-app-plan.md").read_text(encoding="utf-8")
    rows = {}
    for line in plan.splitlines():
        match = re.match(r"\| (F\d{2}|R\d{2}) \|", line)
        if match:
            fields = [part.strip() for part in line.strip("|").split("|")]
            rows[match[1]] = " · ".join(fields[1:])
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    required = requirements()
    previous = json.loads(LEDGER.read_text(encoding="utf-8")) if LEDGER.exists() else {"version": 1, "requirements": []}
    rows = {row["id"]: row for row in previous["requirements"]}
    if not args.check:
        data = {"version": 1, "requirements": [{"id": key, "requirement": value,
                "status": rows.get(key, {}).get("status", "unverified"),
                "layers": rows.get(key, {}).get("layers", {layer: "unverified" for layer in LAYERS}),
                "evidence": rows.get(key, {}).get("evidence", [])} for key, value in sorted(required.items())]}
        LEDGER.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        return
    if set(rows) != set(required) or len(rows) != len(previous["requirements"]):
        raise SystemExit("Acceptance ledger IDs do not match the plan")
    for key, row in rows.items():
        if row["requirement"] != required[key] or set(row["layers"]) != set(LAYERS):
            raise SystemExit(f"Acceptance ledger differs: {key}")
        if row["status"] not in {"unverified", "partial", "accepted"}:
            raise SystemExit(f"Invalid acceptance status: {key}")
        for value in row["layers"].values():
            if value not in {"unverified", "partial", "verified"} and not (isinstance(value, str) and value.startswith("n/a:") and value[4:].strip()):
                raise SystemExit(f"Invalid acceptance layer status: {key}")
        if row["status"] == "accepted" and (not row["evidence"] or any(value in {"unverified", "partial"} for value in row["layers"].values())):
            raise SystemExit(f"Acceptance is missing evidence: {key}")
        for evidence in row["evidence"]:
            target = (ROOT / evidence).resolve()
            if not target.is_relative_to(ROOT) or not target.is_file():
                raise SystemExit(f"Evidence missing: {evidence}")


if __name__ == "__main__":
    main()
