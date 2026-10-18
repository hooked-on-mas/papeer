/** Values shared by the desktop and static website, without transport URLs or credentials. */
export type LibraryItemView = Readonly<{
  id: string;
  title: string;
  kind: "pdf" | "notebook" | "unknown";
  parentId: string | null;
  collectionName: string;
}>;

export type AnnotationTarget = Readonly<{
  paperId: string;
  side: "original" | "translated";
  sourceSha256: string;
}>;

export type ArtifactView = Readonly<{
  /** Opaque, valid only in the runtime that returned it. Never a local path or Drive file ID. */
  id: string;
  itemId: string | null;
  label: string;
  filename: string;
  mediaType: string;
  role: "original" | "translated" | "attachment" | "other";
  annotationTarget?: AnnotationTarget;
}>;

export type SavedReadingView = Readonly<{
  notes: readonly Readonly<{
    id: string;
    page: number | null;
    side: "original" | "translated";
    label: string;
    quote: string;
    note: string;
  }>[];
  messages: readonly Readonly<{
    id: string;
    role: "user" | "assistant" | "other";
    content: string;
  }>[];
}>;

export type RuntimeScope = Readonly<{
  /** A host-created login epoch, NOT an OAuth token, email address, or credential. */
  sessionKey: string;
  libraryId: string;
  revision: string;
}>;

/** Original PDF page number -> exact published translation PDF/page, never an assumed same-page match. */
export type DocumentPagesView = Readonly<{
  pageCount: number;
  translatedPages: Readonly<Record<string, Readonly<{ artifactId: string; page: number }> | null>>;
}>;

export interface ReadonlyLibraryQuery {
  listItems(): readonly LibraryItemView[];
  /** null lists the published documents, excluding settings and internal database files. */
  listArtifacts(itemId: string | null): readonly ArtifactView[];
  readSavedReading(itemId: string, signal?: AbortSignal): Promise<SavedReadingView>;
  /** null means an old snapshot has no page mapping; do not offer paired reading in that case. */
  readDocumentPages(itemId: string, signal?: AbortSignal): Promise<DocumentPagesView | null>;
}

export interface ArtifactStore {
  /** The caller owns and must revoke any object URL made from this Blob. */
  read(id: string, signal?: AbortSignal): Promise<Blob>;
  /** Resolve an embedded relative resource within its published document's item. No network lookup. */
  resolveRelative(baseId: string, relative: string): ArtifactView | undefined;
}

/** Keep account epochs and snapshot revisions in every shared read cache key. */
export function libraryQueryKey(scope: RuntimeScope, ...parts: readonly string[]): readonly string[] {
  return ["library-runtime", scope.sessionKey, scope.libraryId, scope.revision, ...parts];
}
