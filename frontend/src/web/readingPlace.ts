import type { ArtifactView } from "../runtime/contracts.ts";

type DocumentPlace = { page: number; zoom: number; mode: "auto" | "single" | "split"; editing?: boolean; fitPage?: boolean };
type LibraryPlace = { itemId: string; artifact: string };
// Remember navigation across offline restarts, scoped by globally unique Drive library IDs.
const documents = new Map<string, DocumentPlace>();
const libraries = new Map<string, LibraryPlace>();
const PREFIX = "papeer-reading:";
function readSaved(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(PREFIX + key) ?? "null"); } catch { return null; }
}
function persist(key: string, value: unknown) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* Reading can continue with in-memory navigation. */ }
}
export const artifactPlaceKey = (artifact: ArtifactView) => JSON.stringify([artifact.itemId, artifact.filename, artifact.label, artifact.role]);
export const documentPlaceKey = (libraryId: string, itemId: string | null, artifact: ArtifactView) => JSON.stringify([libraryId, itemId, artifact.annotationTarget ? "canonical" : artifactPlaceKey(artifact)]);
export function getDocumentPlace(key: string): DocumentPlace | undefined {
  const value = documents.get(key) ?? readSaved("document:" + key) as DocumentPlace | null;
  return value && Number.isSafeInteger(value.page) && value.page > 0 && value.page <= 100000
    && Number.isFinite(value.zoom) && value.zoom >= .1 && value.zoom <= 10
    && ["auto", "single", "split"].includes(value.mode) ? value : undefined;
}
export function saveDocumentPlace(key: string, place: DocumentPlace) {
  if (documents.size >= 2000 && !documents.has(key)) documents.delete(documents.keys().next().value!);
  documents.set(key, place);
  persist("document:" + key, place);
}
export function getLibraryPlace(libraryId: string): LibraryPlace | undefined {
  const value = libraries.get(libraryId) ?? readSaved("library:" + libraryId) as LibraryPlace | null;
  return value && typeof value.itemId === "string" && typeof value.artifact === "string" ? value : undefined;
}
export function saveLibraryPlace(libraryId: string, place: LibraryPlace) {
  libraries.set(libraryId, place); persist("library:" + libraryId, place);
}
export function clearReadingPlaces() {
  documents.clear(); libraries.clear();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch { /* Browser policy may block navigation storage. */ }
}
