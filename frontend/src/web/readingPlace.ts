import type { ArtifactView } from "../runtime/contracts.ts";
import type { ReadingPlace } from "../features/reader/readingPlace.ts";

type DocumentPlace = { page: number; zoom: number; mode: "auto" | "single" | "split"; editing?: boolean; fitPage?: boolean };
type LibraryPlace = { itemId: string; artifact: string };
// Remember navigation across offline restarts, scoped by globally unique Drive library IDs.
const documents = new Map<string, DocumentPlace>();
const libraries = new Map<string, LibraryPlace>();
const pdfs = new Map<string, [number, ReadingPlace][]>();
const PREFIX = "papeer-reading:";
function readSaved(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(PREFIX + key) ?? "null"); } catch { return null; }
}
function persist(key: string, value: unknown) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* Reading can continue with in-memory navigation. */ }
}
export const artifactPlaceKey = (artifact: ArtifactView) => JSON.stringify([artifact.itemId, artifact.filename, artifact.label, artifact.role]);
export const pdfPlaceKey = (libraryId: string, artifact: ArtifactView, revision: string) =>
  JSON.stringify([libraryId, artifactPlaceKey(artifact), artifact.annotationTarget?.sourceSha256 ?? revision]);
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
function validPoint(value: unknown): value is ReadingPlace {
  if (!value || typeof value !== "object") return false;
  const point = value as ReadingPlace;
  return Number.isFinite(point.x) && point.x >= 0 && point.x <= 1 && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1;
}
function pdfPages(key: string) {
  let pages = pdfs.get(key);
  if (!pages) {
    const saved = readSaved("pdf:" + key);
    pages = Array.isArray(saved) ? saved.filter((entry): entry is [number, ReadingPlace] => Array.isArray(entry)
      && Number.isSafeInteger(entry[0]) && entry[0] > 0 && entry[0] <= 100000 && validPoint(entry[1])).slice(-20) : [];
    if (pdfs.size >= 300) pdfs.delete(pdfs.keys().next().value!);
    pdfs.set(key, pages);
  }
  return pages;
}
export function getPdfPlace(key: string, page: number): ReadingPlace | undefined {
  return pdfPages(key).find(entry => entry[0] === page)?.[1];
}
/** Scroll events update memory; disk writes are deferred and flushed when leaving. */
export function rememberPdfPlace(key: string, page: number, place: ReadingPlace) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !validPoint(place)) return;
  const pages = pdfPages(key).filter(entry => entry[0] !== page);
  pages.push([page, { ...place }]); pdfs.set(key, pages.slice(-20));
}
export function persistPdfPlaces(key: string) {
  const pages = pdfs.get(key);
  if (pages) persist("pdf:" + key, pages);
}
export function clearReadingPlaces() {
  documents.clear(); libraries.clear(); pdfs.clear();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch { /* Browser policy may block navigation storage. */ }
}
