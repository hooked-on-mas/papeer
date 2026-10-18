// An HTML document opened large takes the place of the reader (app/ReaderArea.tsx), so a request to
// read a page of its paper has to bring the reader back, or the page would be set behind the document.
// Kept apart from the stores (which it is given) so that the rule is the same wherever a page is
// asked for, and can be tried without the app.

type Listener<T> = (state: T, previous: T) => void;

/** The part of a zustand store this needs, so that a plain vanilla store can stand in for the app's. */
export type Watched<T> = { getState(): T; subscribe(listener: Listener<T>): unknown };
/** The document state's store, which holds the owner of the document opened large. */
export type DocumentStore = { getState(): { enlarged: string | null }; setState(state: { enlarged: null }): void };

/** Brings the reader back when the owner's document is the one opened large; any other is left as it is. */
export function leaveEnlargedDocument(store: DocumentStore, owner: string | null | undefined): void {
  if (owner && store.getState().enlarged === owner) store.setState({ enlarged: null });
}

/**
 * Every jump to a place of a paper (a library search hit, a sticky note, a link, the contents, a passage
 * of the chat) is made through the store's readerJump, so watching it covers them all, whoever sets it.
 * The reader clearing the jump afterwards is not a request, and a jump to another paper leaves the
 * document of this one as it is: the other paper's reader is shown and this document is there on return.
 */
export function leaveEnlargedDocumentOnJump(
  reader: Watched<{ readerJump: { paperId: string } | null }>, documents: DocumentStore,
): void {
  reader.subscribe((state, previous) => {
    const jump = state.readerJump;
    if (jump && jump !== previous.readerJump) leaveEnlargedDocument(documents, jump.paperId);
  });
}
