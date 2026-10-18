import type { ArtifactView } from "../runtime/contracts.ts";

/** Open the saved Japanese PDF directly; attachments are reached through the library. */
export function preferredReadingArtifact(files: readonly ArtifactView[]) {
  return files.find(file => file.role === "translated" && file.annotationTarget && file.filename.endsWith(".pdf"))
    ?? files.find(file => file.role === "translated" && file.filename.endsWith(".pdf"))
    ?? files.find(file => file.role === "original" && file.filename.endsWith(".pdf"))
    ?? files[0];
}
