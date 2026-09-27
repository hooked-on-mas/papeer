"""BibTeX entries made from the library's own data: keys, escaping, kinds, and saving a folder's .bib."""
from fastapi.testclient import TestClient
import pymupdf
import pytest

from papeer.core.bibtex import bibtex, citation_key, citation_keys, entry, escape, export_bibtex
from papeer.core.storage import Library
from sidecar import app as runtime


def paper(**values) -> dict:
    return {"title": "Deep Learning for Control", "first_author": "Jane Smith", "publication_year": "2020",
            "doi": "", "arxiv_id": "", "venue": "", **values}


def test_key_is_family_name_year_and_first_word_of_the_title():
    assert citation_key(paper()) == "smith2020deep"
    assert citation_key(paper(first_author="Smith, Jane", title="The Art of Control")) == "smith2020art"
    assert citation_key(paper(first_author="Jürgen Müller", title="Über Regelung")) == "muller2020uber"
    assert citation_key(paper(first_author="van der Berg, A.", publication_year="")) == "vanderbergdeep"
    # Japanese names and titles leave no ASCII: what there is, else "paper" with the year.
    assert citation_key(paper(first_author="山田太郎", title="Deep Learning")) == "2020deep"
    assert citation_key(paper(first_author="山田太郎", title="制御のための深層学習")) == "paper2020"
    assert citation_key(paper(first_author="", title="", publication_year="")) == "paper"
    # From the name before "et al.", without Jr./III.
    assert citation_key(paper(first_author="Jane Smith et al.")) == "smith2020deep"
    assert citation_key(paper(first_author="John Smith Jr.")) == "smith2020deep"
    assert citation_key(paper(first_author="Smith, Jr., John")) == "smith2020deep"
    assert citation_key(paper(first_author="Henry Ford III and Jane Doe")) == "ford2020deep"


def test_authors_et_al_become_and_others():
    def author(value: str) -> str:
        return next(line for line in entry(paper(first_author=value), "k").splitlines() if line.startswith("  author"))

    assert author("Jane Smith et al.") == "  author = {Jane Smith and others},"
    assert author("Smith, J., et al") == "  author = {Smith, J. and others},"
    assert author("山田太郎ほか") == "  author = {山田太郎 and others},"
    assert author("Jane Smith and others") == "  author = {Jane Smith and others},"
    assert author("John Smith Jr.; Ann Lee III") == "  author = {John Smith and Ann Lee},"
    assert author("Smith, Jr., John") == "  author = {Smith, John},"
    assert "author" not in entry(paper(first_author="et al."), "k")


def test_papers_that_would_share_a_key_get_letters_in_order():
    # The first (oldest) keeps its key, so adding a paper changes no key cited already.
    papers = [paper(), paper(title="Deep Models"), paper(first_author="Doe"), paper(title="Deep nets")]
    assert citation_keys(papers) == ["smith2020deep", "smith2020deep-a", "doe2020deep", "smith2020deep-b"]
    # The hyphen keeps them apart from another paper's own key, which has none.
    assert citation_keys([paper(), paper(), paper(title="Deepa")]) == ["smith2020deep", "smith2020deep-a", "smith2020deepa"]
    # Adding a paper changes none of the keys before it.
    before = citation_keys(papers)
    assert citation_keys([*papers, paper(title="Deep again"), paper(title="Deepa")])[:len(papers)] == before
    assert len(set(citation_keys([paper()] * 30))) == 30


def test_special_characters_are_escaped_and_unicode_kept():
    assert escape("R&D: 100% of $x_1$ #1 ^ ~ {a} \\ b") == (
        r"R\&D: 100\% of \$x\_1\$ \#1 \textasciicircum{} \textasciitilde{} \textbraceleft{}a\textbraceright{}"
        r" \textbackslash{} b")
    text = entry(paper(title="Ünïcode {broken and 深層学習の\n制御", first_author="山田太郎; 佐藤花子}",
                       venue="Journal } of {{ X"), "key")
    assert "  title = {{Ünïcode \\textbraceleft{}broken and 深層学習の 制御}}," in text
    assert "  author = {山田太郎 and 佐藤花子\\textbraceright{}}," in text
    # Braces stay balanced whatever the fields hold: BibTeX and biber count \{ and \} as braces too,
    # so the raw characters must balance, entry by entry and within each field.
    assert text.count("{") == text.count("}")
    for line in text.splitlines()[1:-1]:
        assert line.count("{") == line.count("}"), line


def test_entry_kind_follows_the_venue():
    journal = entry(paper(venue="IEEE Transactions on Automatic Control", doi="10.1109/TAC.2014.2363123"), "k")
    assert journal == ("@article{k,\n  title = {{Deep Learning for Control}},\n  author = {Jane Smith},\n"
                       "  journal = {IEEE Transactions on Automatic Control},\n  year = {2020},\n"
                       "  doi = {10.1109/TAC.2014.2363123}\n}\n")
    assert entry(paper(venue="ICLR 2021"), "k").startswith("@inproceedings{k,")
    assert "  booktitle = {Proceedings of the 2019 Conference on X}," in entry(paper(venue="Proceedings of the 2019 Conference on X"), "k")
    preprint = entry(paper(arxiv_id="2101.00001", publication_year=""), "k")
    assert preprint == ("@misc{k,\n  title = {{Deep Learning for Control}},\n  author = {Jane Smith},\n"
                        "  eprint = {2101.00001},\n  archiveprefix = {arXiv}\n}\n")
    # A malformed identifier (typed before it was checked) is left out rather than breaking the file.
    assert "doi" not in entry(paper(doi="10.1/x}"), "k")


def test_bibtex_joins_the_entries_with_their_keys():
    text = bibtex([paper(), paper(title="Deep Models")])
    assert text.startswith("@misc{smith2020deep,") and "\n\n@misc{smith2020deep-a," in text


def test_export_refuses_the_library_and_other_extensions(tmp_path):
    root = tmp_path / "library"
    root.mkdir()
    with pytest.raises(ValueError, match="ライブラリの外"):
        export_bibtex(root / "refs.bib", [paper()], root)
    with pytest.raises(ValueError, match=r"\.bib"):
        export_bibtex(tmp_path / "refs.txt", [paper()], root)
    with pytest.raises(ValueError, match="論文がありません"):
        export_bibtex(tmp_path / "refs.bib", [], root)
    assert export_bibtex(tmp_path / "refs.bib", [paper(title="深層学習")], root) == 1
    assert (tmp_path / "refs.bib").read_bytes().decode("utf-8").startswith("@misc{smith2020,\n  title = {{深層学習}},")


@pytest.fixture
def client_env(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    ids = []
    for name, folder in [("Alpha", "研究 / 制御"), ("Beta", "研究"), ("Gamma", "他")]:
        source = tmp_path / f"{name}.pdf"
        with pymupdf.open() as pdf:
            pdf.new_page().insert_text((72, 72), f"{name}\ndoi:10.1000/{name.lower()}")
            pdf.save(source)
        identity, _ = lib.import_pdf(source, folder)
        lib.update(identity, title=name, first_author="Smith", publication_year="2021")
        ids.append(identity)
    # Added a second apart, oldest first (created_at counts whole seconds).
    with lib.connection() as db:
        db.executemany("UPDATE papers SET created_at=? WHERE id=?",
                       [(f"2026-01-01 00:00:0{index}", identity) for index, identity in enumerate(ids)])
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    return lib, ids


def test_papers_added_within_one_second_keep_the_order_they_were_added_in(client_env):
    lib, ids = client_env
    with lib.connection() as db:
        db.execute("UPDATE papers SET created_at='2026-01-01 00:00:00'")
    for _ in range(3):
        assert [p["id"] for p in lib.papers_by_id([ids[2], ids[0], ids[1]])] == ids
    assert [p["id"] for p in lib.collection_papers("研究")] == ids[:2]
    assert "insert_order" not in lib.papers_by_id(ids)[0]


def test_copy_and_folder_export_through_the_api(client_env, tmp_path):
    lib, (alpha, beta, gamma) = client_env
    with TestClient(runtime.app) as client:
        response = client.patch(f"/api/papers/{alpha}", json={"venue": "Journal of Tests", "arxiv_id": "arXiv:2101.00001v2"})
        assert response.status_code == 200
        assert client.patch(f"/api/papers/{alpha}", json={"doi": "no doi"}).status_code == 400
        # A DOI that would be saved cut short (an old SICI DOI with <>) is refused, not truncated.
        sici = "10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-O"
        assert client.patch(f"/api/papers/{alpha}", json={"doi": sici}).status_code == 400
        paper = client.get(f"/api/papers/{alpha}").json()
        assert (paper["doi"], paper["arxiv_id"], paper["venue"]) == ("10.1000/alpha", "2101.00001", "Journal of Tests")

        copied = client.post("/api/papers/bibtex", json={"paper_ids": [gamma, alpha]}).json()
        assert copied["count"] == 2
        # Oldest first: Alpha was added before Gamma.
        assert copied["text"].index("@article{smith2021alpha,") < copied["text"].index("@misc{smith2021gamma,")
        assert "  doi = {10.1000/alpha}," in copied["text"]
        assert client.post("/api/papers/bibtex", json={"paper_ids": ["0" * 32]}).status_code == 404
        assert client.post("/api/papers/bibtex", json={"paper_ids": ["../x"]}).status_code == 400

        destination = tmp_path / "out" / "研究.bib"
        destination.parent.mkdir()
        saved = client.post("/api/collections/bibtex", json={"collection": "研究", "destination": str(destination)})
        assert saved.status_code == 200 and saved.json()["count"] == 2
        written = destination.read_text("utf-8")
        assert "smith2021alpha" in written and "smith2021beta" in written and "gamma" not in written
        inside = client.post("/api/collections/bibtex", json={"collection": "研究", "destination": str(lib.root / "x.bib")})
        assert inside.status_code == 400 and "ライブラリの外" in inside.json()["detail"]
        assert not (lib.root / "x.bib").exists()
        empty = client.post("/api/collections/bibtex", json={"collection": "無い", "destination": str(destination)})
        assert empty.status_code == 400


def test_bibtex_routes_never_reach_the_network(client_env, monkeypatch):
    # Everything comes from the library: any attempt to open a connection fails the test.
    import socket

    def refuse(*_args, **_kwargs):
        raise AssertionError("network access")

    _lib, ids = client_env
    with TestClient(runtime.app) as client:
        monkeypatch.setattr(socket, "create_connection", refuse)
        monkeypatch.setattr(socket.socket, "connect", refuse)
        assert client.post("/api/papers/bibtex", json={"paper_ids": ids}).status_code == 200
