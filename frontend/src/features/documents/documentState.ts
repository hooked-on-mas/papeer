import { create } from "zustand";
import { useStore } from "@/store";
import { leaveEnlargedDocument, leaveEnlargedDocumentOnJump } from "./enlargedDocument";

type State = { selected: Record<string, string>; modes: Record<string, "md" | "html">; enlarged: string | null };
export const useDocumentState = create<State>(() => ({ selected: {}, modes: {}, enlarged: null }));
// Page jumps (search hits, sticky notes, links, passages) bring the reader back from an enlarged document.
leaveEnlargedDocumentOnJump(useStore, useDocumentState);
/**
 * A request to read a page of `owner` that is not made through the store's readerJump (a page citation,
 * the page field) brings the reader back from the owner's enlarged document. A document search hit or
 * citation opens the document itself (openDocument) and does not come through here.
 */
export function showReaderOf(owner: string | null | undefined) { leaveEnlargedDocument(useDocumentState, owner); }
export function showMemos(owner: string) {
  useDocumentState.setState(s => ({ modes: { ...s.modes, [owner]: "md" }, enlarged: null }));
}
export function selectDocument(owner: string, id: string) {
  useDocumentState.setState(s => ({ selected: { ...s.selected, [owner]: id }, modes: { ...s.modes, [owner]: "html" } }));
}
export function openDocument(owner: string, id?: string) {
  useDocumentState.setState(s => ({ selected: id ? { ...s.selected, [owner]: id } : s.selected,
    modes: { ...s.modes, [owner]: "html" }, enlarged: null }));
  const state = useStore.getState();
  state.setActivePaperId(owner); state.setSelectedFolder(null); state.setActiveTab("reader"); state.setSidePanel("notes");
}
export function enlargeDocument(owner: string) {
  useDocumentState.setState({ enlarged: owner });
  useStore.getState().setSidePanel(null);
}
export function shrinkDocument(owner: string) { openDocument(owner); }
