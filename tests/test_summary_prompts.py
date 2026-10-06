"""Writing guidance reaches every notes chunk and the article, respecting custom prompts."""
import copy
from pathlib import Path
import threading
from unittest.mock import patch

import pytest

from papeer.core import prompts
from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService
from papeer.core.storage import Library


@pytest.mark.parametrize("custom", [None, "独自の指示\n{{summary_style}}", "独自の指示"])
def test_summary_sends_expanded_guidance_to_every_stage(tmp_path, custom):
    library = Library(tmp_path / "library")
    paper_id, _ = library.import_pdf(Path(__file__).parent / "fixtures" / "sample.pdf")
    document = copy.deepcopy(library.document(paper_id))
    document["pages"][0]["text"] = "Source text. " * 2500  # Several notes requests.
    names = ("summary_notes", "summary_article")
    if custom is not None:
        prompts.save_overrides(dict.fromkeys(names, custom))

    class Provider:
        def __init__(self):
            self.calls = []

        def generate(self, instruction, data):
            self.calls.append((instruction, data))
            return f"確認した結果。 [{paper_id}:p1]"

    provider = Provider()
    with patch.object(library, "document", return_value=document):
        article = PaperService(library, provider, threading.Event()).article(paper_id)

    assert len(provider.calls) >= 3
    style = prompts.builtin("_summary_style")
    for index, (instruction, data) in enumerate(provider.calls):
        name = "summary_article" if index == len(provider.calls) - 1 else "summary_notes"
        assert instruction == prompts.expand(prompts.load(name))
        assert "{{summary_style}}" not in instruction
        assert instruction.count(style) == (0 if custom == "独自の指示" else 1)
        assert f"[{paper_id}:p1]" in data
    assert f"[p.1](papeer://{paper_id}/1)" in article
    assert PaperFiles(library.folder(paper_id)).article_md.read_text("utf-8") == article
    assert "_summary_style" not in prompts.defaults()
