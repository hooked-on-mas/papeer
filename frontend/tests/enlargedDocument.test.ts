// An HTML document opened large replaces the reader; asking to read a page of its paper (a page
// citation, a library search hit, a sticky note, a link, the page field) must bring the reader back.
// The rule is checked over vanilla stores shaped like the app's reader store (readerJump) and
// document state (enlarged): the jumps are set as navigation.ts, LibrarySidebar and StickyNotesTab set them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import { leaveEnlargedDocument, leaveEnlargedDocumentOnJump } from "../src/features/documents/enlargedDocument.ts";

type Jump = { paperId: string; page: number; side: "original" | "translated"; text: string; anchor_y: number };

function app(enlarged: string | null = "owner") {
  const reader = createStore<{ activePaperId: string | null; currentPage: number; readerJump: Jump | null }>(
    () => ({ activePaperId: "owner", currentPage: 1, readerJump: null }));
  const documents = createStore<{ enlarged: string | null }>(() => ({ enlarged }));
  leaveEnlargedDocumentOnJump(reader, documents);
  const jump = (paperId: string, page: number, side: Jump["side"] = "original") =>
    reader.setState({ activePaperId: paperId, currentPage: page, readerJump: { paperId, page, side, text: "", anchor_y: 0 } });
  /** What ReaderArea shows for the open paper: the enlarged document replaces the reader only for its own paper. */
  const shown = () => documents.getState().enlarged === reader.getState().activePaperId ? "document" : "reader";
  return { reader, documents, jump, shown };
}

test("a jump to a page of the paper whose document is open large brings the reader back, at that page", () => {
  for (const side of ["original", "translated"] as const) {
    const { reader, documents, jump, shown } = app();
    assert.equal(shown(), "document");
    jump("owner", 7, side);
    assert.equal(documents.getState().enlarged, null);
    assert.equal(shown(), "reader");
    assert.equal(reader.getState().currentPage, 7);
    // The reader takes the jump when it mounts; it is still there for it.
    assert.deepEqual(reader.getState().readerJump?.page, 7);
  }
});

test("the reader taking the jump away, or an unrelated change, does not bring an enlarged document back or take it away", () => {
  const { reader, documents, jump } = app();
  jump("owner", 3);
  documents.setState({ enlarged: "owner" });
  reader.setState({ readerJump: null });
  reader.setState({ currentPage: 4 });
  assert.equal(documents.getState().enlarged, "owner");
});

test("a jump to another paper leaves this paper's document as it is, and the other paper's reader is shown", () => {
  const { documents, jump, shown, reader } = app();
  jump("other", 2);
  assert.equal(shown(), "reader");
  assert.equal(documents.getState().enlarged, "owner");
  // A page of this paper asked for from there brings its reader back, not its document.
  jump("owner", 5);
  assert.equal(documents.getState().enlarged, null);
  assert.equal(shown(), "reader");
  assert.equal(reader.getState().currentPage, 5);
});

test("a page citation, which sets no jump, brings the reader back by the explicit path, for its own paper only", () => {
  const { documents, shown, reader } = app();
  leaveEnlargedDocument(documents, "other");
  leaveEnlargedDocument(documents, null);
  leaveEnlargedDocument(documents, undefined);
  assert.equal(documents.getState().enlarged, "owner");
  // followCitation: leave the document, then open the paper at the page.
  leaveEnlargedDocument(documents, "owner");
  reader.setState({ activePaperId: "owner", currentPage: 9 });
  assert.equal(documents.getState().enlarged, null);
  assert.equal(shown(), "reader");
  assert.equal(reader.getState().currentPage, 9);
});

test("a page citation of another paper keeps the document of this one for when it is opened again", () => {
  const { documents, shown, reader } = app();
  leaveEnlargedDocument(documents, "other");
  reader.setState({ activePaperId: "other", currentPage: 3 });
  assert.equal(shown(), "reader");
  reader.setState({ activePaperId: "owner" });
  assert.equal(shown(), "document");
});

test("nothing is written to the document state when no document is open large", () => {
  const { documents, jump } = app(null);
  let writes = 0;
  documents.subscribe(() => { writes++; });
  jump("owner", 2);
  leaveEnlargedDocument(documents, "owner");
  assert.equal(writes, 0);
});
