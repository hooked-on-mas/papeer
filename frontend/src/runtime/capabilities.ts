import type { ArtifactView } from "./contracts.ts";

/** Read access never depends on AI login or permission to create a new translation. */
export type LibraryCapabilities = Readonly<{
  "library.read": boolean;
  "translation.read": boolean;
  "ink.append": boolean;
  "notes.read": boolean;
  "chat.read": boolean;
  "translation.generate": boolean;
  "chat.generate": boolean;
  "provider.configure": boolean;
}>;

/** Static Web library policy. This host has no AI execution or provider settings. */
export function webLibraryCapabilities(artifacts: readonly ArtifactView[], hasSavedReading: boolean): LibraryCapabilities {
  return Object.freeze({
    "library.read": true,
    "translation.read": artifacts.some(artifact => artifact.role === "translated"),
    "ink.append": artifacts.some(artifact => !!artifact.annotationTarget),
    "notes.read": hasSavedReading,
    "chat.read": hasSavedReading,
    "translation.generate": false,
    "chat.generate": false,
    "provider.configure": false,
  });
}
