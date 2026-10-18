import type { ArtifactView } from "../runtime/contracts.ts";

type DocumentPlace = { page: number; zoom: number; mode: "auto" | "single" | "split" };
type LibraryPlace = { itemId: string; artifact: string };
// Navigation state is memory-only, scoped by globally unique Drive library IDs.
const documents = new Map<string, DocumentPlace>();
const libraries = new Map<string, LibraryPlace>();
export const artifactPlaceKey = (artifact: ArtifactView) => JSON.stringify([artifact.itemId, artifact.filename, artifact.label, artifact.role]);
export const documentPlaceKey = (libraryId: string, itemId: string | null, artifact: ArtifactView) => JSON.stringify([libraryId, itemId, artifact.annotationTarget ? "canonical" : artifactPlaceKey(artifact)]);
export const getDocumentPlace = (key: string) => documents.get(key);
export function saveDocumentPlace(key: string, place: DocumentPlace) {
  if (documents.size >= 2000 && !documents.has(key)) documents.delete(documents.keys().next().value!);
  documents.set(key, place);
}
export const getLibraryPlace = (libraryId: string) => libraries.get(libraryId);
export const saveLibraryPlace = (libraryId: string, place: LibraryPlace) => libraries.set(libraryId, place);
export function clearReadingPlaces() { documents.clear(); libraries.clear(); }
