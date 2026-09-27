from pathlib import Path

import pytest

from papeer.core.storage import Library


@pytest.fixture
def library(tmp_path):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    lib.update(identity, collection_name="Parent / Child")
    lib.create_collection("Parent / Empty")
    with lib.connection() as db:
        db.execute("INSERT INTO collection_glossaries VALUES(?,?)", ("Parent / Child", '[{"source":"test","target":"試験"}]'))
    return lib, identity


def test_restore_subtree_papers_and_glossaries(library):
    lib, identity = library
    assert lib.delete_collection("Parent", undo_token="undo") == [identity]
    # The snapshot survives reopening the library.
    lib = Library(lib.root)
    assert "Parent / Empty" not in lib.collections()
    assert lib.restore_collection("undo") == "Parent"
    assert "Parent / Empty" in lib.collections()
    with lib.connection() as db:
        assert db.execute("SELECT collection_name FROM papers WHERE id=?", (identity,)).fetchone()[0] == "Parent / Child"
        assert db.execute("SELECT terms FROM collection_glossaries WHERE name='Parent / Child'").fetchone()[0] == '[{"source":"test","target":"試験"}]'
    assert (lib.folder(identity) / "original.pdf").is_file()
    with pytest.raises(ValueError):
        lib.restore_collection("undo")


def test_restore_empty_folder(tmp_path):
    lib = Library(tmp_path)
    lib.create_collection("Empty / Child")
    lib.delete_collection("Empty", undo_token="undo")
    lib.restore_collection("undo")
    assert "Empty / Child" in lib.collections()


@pytest.mark.parametrize("conflict", ["folder", "move", "delete"])
def test_restore_refuses_conflicts_without_partial_changes(library, conflict):
    lib, identity = library
    lib.delete_collection("Parent", undo_token="undo")
    with lib.connection() as db:
        if conflict == "folder":
            db.execute("INSERT INTO collections VALUES('Parent / New')")
        elif conflict == "move":
            db.execute("UPDATE papers SET collection_name='Elsewhere' WHERE id=?", (identity,))
        else:
            db.execute("DELETE FROM papers WHERE id=?", (identity,))
    with pytest.raises(ValueError):
        lib.restore_collection("undo")
    assert "Parent / Empty" not in lib.collections()
    with lib.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM collection_glossaries").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM collection_undo").fetchone()[0] == 1


def test_restore_unknown_token(tmp_path):
    with pytest.raises(ValueError):
        Library(tmp_path).restore_collection("unknown")
