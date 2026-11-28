import type { ArtifactView } from "./contracts.ts";
import type { ItemCapabilities } from "../lib/itemKinds.ts";

/** Host permissions are separate from item kinds and from data already saved for an item. */
export type ReaderPanelHost = Readonly<{
  readSaved: boolean;
  generateSummary: boolean;
  generateChat: boolean;
  editNotes: boolean;
  editStickyNotes: boolean;
}>;

export const DESKTOP_READER_PANEL_HOST: ReaderPanelHost = Object.freeze({
  readSaved: true, generateSummary: true, generateChat: true, editNotes: true, editStickyNotes: true,
});

export type ReaderPanelData = Partial<Record<"summary" | "chat" | "notes" | "sticky-notes", boolean>>;

/** Saved chat remains readable even when this kind cannot create a new AI answer. */
export function readerPanelCapabilities(kind: ItemCapabilities, host: ReaderPanelHost, saved: ReaderPanelData = {}) {
  return {
    summary: kind.summary && (host.generateSummary || (host.readSaved && !!saved.summary)),
    chat: (kind.chat && host.generateChat) || (host.readSaved && !!saved.chat),
    notes: kind.memo && (host.editNotes || (host.readSaved && !!saved.notes)),
    "sticky-notes": kind.stickyNotes && (host.editStickyNotes || (host.readSaved && !!saved["sticky-notes"])),
  };
}

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
