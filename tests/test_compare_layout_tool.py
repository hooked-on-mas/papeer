import io
import json
from pathlib import Path
import shutil

import pytest

from tools.compare_layout import compare_documents, diff, main, pdf_sources, snapshot

FIXTURE = Path(__file__).parent / "fixtures/sample.pdf"


@pytest.fixture
def library(tmp_path):
    folder = tmp_path / "library" / "papers" / ("a" * 32)
    folder.mkdir(parents=True)
    shutil.copyfile(FIXTURE, folder / "original.pdf")
    return tmp_path / "library"


def test_sources_accept_library_folder_and_files(library, tmp_path):
    loose = tmp_path / "loose"
    loose.mkdir()
    shutil.copyfile(FIXTURE, loose / "paper.pdf")
    assert [identity for identity, _ in pdf_sources([library])] == ["a" * 32]
    assert [identity for identity, _ in pdf_sources([library / "papers"])] == ["a" * 32]
    assert [identity for identity, _ in pdf_sources([loose])] == ["paper"]
    assert [identity for identity, _ in pdf_sources([loose / "paper.pdf"])] == ["paper"]
    with pytest.raises(SystemExit, match="重複"):
        pdf_sources([loose, loose / "paper.pdf"])


def test_snapshot_extracts_without_touching_the_library(library, tmp_path):
    before = sorted(p.relative_to(library) for p in library.rglob("*"))
    summary = snapshot(tmp_path / "out" / "after", [library], out=io.StringIO())
    assert sorted(p.relative_to(library) for p in library.rglob("*")) == before
    saved = json.loads((tmp_path / "out" / "after" / f"{'a' * 32}.json").read_text(encoding="utf-8"))
    assert saved["comparison_units"] and all("comparison_style" in b for b in saved["blocks"])
    assert summary[0]["blocks"] == len(saved["blocks"])
    assert json.loads((tmp_path / "out" / "after" / "summary.json").read_text(encoding="utf-8"))["documents"]


@pytest.mark.parametrize("given", ["library", "papers", "pdf"])
@pytest.mark.parametrize("inside", ["", "papers/x", "layout", "papers/" + "a" * 32 + "/snapshot"])
def test_snapshot_refuses_output_anywhere_in_the_source_library(library, given, inside):
    source = {"library": library, "papers": library / "papers",
              "pdf": library / "papers" / ("a" * 32) / "original.pdf"}[given]
    output = library / inside if inside else library
    with pytest.raises(SystemExit, match="ライブラリ"):
        snapshot(output, [source], out=io.StringIO())
    assert not (output / "summary.json").exists()


def test_snapshot_refuses_output_in_the_default_library(library, tmp_path):
    from papeer.core.paths import data_directory

    with pytest.raises(SystemExit, match="ライブラリ"):
        snapshot(data_directory() / "layout", [library], out=io.StringIO())
    loose = tmp_path / "loose"
    loose.mkdir()
    shutil.copyfile(FIXTURE, loose / "paper.pdf")
    with pytest.raises(SystemExit, match="ライブラリ"):
        snapshot(loose / "out", [loose / "paper.pdf"], out=io.StringIO())
    snapshot(tmp_path / "beside", [loose / "paper.pdf"], out=io.StringIO())


def test_diff_reports_nothing_for_identical_snapshots_and_each_kind_of_change(library, tmp_path):
    snapshot(tmp_path / "before", [library], out=io.StringIO())
    shutil.copytree(tmp_path / "before", tmp_path / "after")
    out = io.StringIO()
    report = diff(tmp_path / "before", tmp_path / "after", out=out)
    same = report["documents"][0]
    assert not any(same[key] for key in ("styles", "margins", "content_changed", "order", "characters",
                                         "added_blocks", "removed_blocks", "added_continuations"))
    assert (tmp_path / "before-vs-after.json").exists()
    assert "| aaaaaaaa |" in out.getvalue()

    document = json.loads((tmp_path / "before" / f"{'a' * 32}.json").read_text(encoding="utf-8"))
    changed = json.loads(json.dumps(document))
    first, second = changed["blocks"][0], changed["blocks"][1]
    first["comparison_style"] = {"role": "title", "size": 30.0}
    first["running_header"] = True
    second["text"] = second["text"] + " extra"
    changed["blocks"][0], changed["blocks"][1] = second, first
    changed["continuations"] = [{"blocks": [first["id"], second["id"]], "pages": [1], "boundary": "column"}]
    result = compare_documents(document, changed)
    assert [s["id"] for s in result["styles"]] == [first["id"]]
    assert [m["id"] for m in result["margins"]] == [first["id"]]
    assert result["content_changed"] == [second["id"]]
    assert result["order"][0]["page"] == first["page"]
    assert result["characters"][0]["added"] == len("extra")
    assert result["added_continuations"][0]["ids"] == [first["id"], second["id"]]


def test_command_line_diff(library, tmp_path, capsys):
    snapshot(tmp_path / "before", [library], out=io.StringIO())
    snapshot(tmp_path / "after", [library], out=io.StringIO())
    assert main(["diff", str(tmp_path / "before"), str(tmp_path / "after"),
                 "--output", str(tmp_path / "report.json")]) == 0
    assert "翻訳単位" in capsys.readouterr().out
    assert json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))["documents"][0]["id"] == "a" * 32
