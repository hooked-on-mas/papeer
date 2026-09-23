import os
from pathlib import Path

_DIR = Path(__file__).parent / "prompts"

def load(name: str) -> str:
    return (_DIR / f"{name}.txt").read_text(encoding="utf-8").strip()
