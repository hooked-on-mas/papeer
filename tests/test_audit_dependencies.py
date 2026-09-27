"""tools/audit_dependencies.py (just audit), with the external tools replaced: nothing is queried."""
import io
from pathlib import Path

import pytest

from tools.audit_dependencies import ECOSYSTEMS, PIP_AUDIT, audit, main

ROOT = Path("C:/repo")
TOOLS = {"uv": "C:/bin/uv.exe", "uvx": "C:/bin/uvx.exe", "pnpm": "C:/bin/pnpm.CMD", "cargo": "C:/bin/cargo.exe"}


class FakeTools:
    """Records the commands; exit codes come from `codes` keyed by the subcommand (default 0)."""

    def __init__(self, installed=TOOLS, codes=None):
        self.installed = dict(installed)
        self.codes = codes or {}
        self.calls: list[tuple[list[str], Path, bool]] = []

    def which(self, name):
        return self.installed.get(name)

    def run(self, command, cwd, capture):
        self.calls.append((command, cwd, capture))
        if command[1] == "export":
            Path(command[-1]).write_text("pillow==12.1.0 --hash=sha256:00\n", encoding="utf-8")
        key = " ".join(command[1:3]) if command[1] == "audit" else command[1]
        return self.codes.get(key, 0), "output"


def test_every_check_runs_on_the_lock_files():
    tools = FakeTools()
    out = io.StringIO()
    results = audit(list(ECOSYSTEMS), ROOT, tools.run, tools.which, out=out)
    assert [result.status for result in results] == ["ok", "ok", "ok"]
    commands = [call[0] for call in tools.calls]
    export, pip_audit, pnpm, cargo_version, cargo = commands
    assert export[:3] == ["C:/bin/uv.exe", "export", "--frozen"] and "--all-groups" in export
    assert pip_audit[:2] == ["C:/bin/uvx.exe", f"pip-audit@{PIP_AUDIT}"] and "--disable-pip" in pip_audit
    assert pip_audit[pip_audit.index("--requirement") + 1] == export[-1]
    assert not Path(export[-1]).exists()  # The exported list lives in a temporary folder.
    assert pnpm == ["C:/bin/pnpm.CMD", "audit"] and tools.calls[2][1] == ROOT / "frontend"
    assert cargo_version == ["C:/bin/cargo.exe", "audit", "--version"]
    assert cargo == ["C:/bin/cargo.exe", "audit", "--file", str(ROOT / "frontend/src-tauri/Cargo.lock")]
    # The reports go straight to the terminal; only the probes are captured.
    assert [call[2] for call in tools.calls] == [True, False, False, True, False]
    assert out.getvalue().count("既知の脆弱性はありません") == 3


def test_a_missing_cargo_audit_is_explained_and_fails():
    tools = FakeTools(codes={"audit --version": 101})
    out = io.StringIO()
    [result] = audit(["rust"], ROOT, tools.run, tools.which, out=out)
    assert result.status == "missing"
    assert "cargo install cargo-audit --locked" in out.getvalue()
    assert len(tools.calls) == 1  # cargo audit itself was not run


@pytest.mark.parametrize("missing,ecosystem,hint", [
    ("uvx", "python", "https://docs.astral.sh/uv/"),
    ("pnpm", "javascript", "https://pnpm.io/installation"),
    ("cargo", "rust", "https://www.rust-lang.org/tools/install"),
])
def test_a_missing_tool_is_reported_without_stopping_the_others(missing, ecosystem, hint):
    tools = FakeTools(installed={k: v for k, v in TOOLS.items() if k != missing})
    out = io.StringIO()
    results = audit(list(ECOSYSTEMS), ROOT, tools.run, tools.which, out=out)
    statuses = {result.ecosystem: result.status for result in results}
    assert statuses.pop(ecosystem) == "missing"
    assert set(statuses.values()) == {"ok"}
    assert hint in out.getvalue()


def test_findings_and_failures_are_flagged():
    tools = FakeTools(codes={"audit": 1})  # pnpm audit found something
    [result] = audit(["javascript"], ROOT, tools.run, tools.which, out=io.StringIO())
    assert result.status == "found"
    tools = FakeTools(codes={"export": 2})  # uv export failed: pip-audit is not run
    [result] = audit(["python"], ROOT, tools.run, tools.which, out=io.StringIO())
    assert result.status == "found" and "uv export" in result.message
    assert len(tools.calls) == 1


def test_cli_selects_ecosystems_and_sets_the_exit_code(monkeypatch):
    import tools.audit_dependencies as module

    seen = []

    def fake_audit(ecosystems):
        seen.append(ecosystems)
        return [module.Result(name, "ok" if name != "rust" else "missing", "") for name in ecosystems]

    monkeypatch.setattr(module, "audit", fake_audit)
    assert main(["rust", "python"]) == 1
    assert main(["javascript"]) == 0
    assert main([]) == 1
    assert seen == [["python", "rust"], ["javascript"], list(ECOSYSTEMS)]
    with pytest.raises(SystemExit):
        main(["ruby"])
