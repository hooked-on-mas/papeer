/**
 * Changes to the library's data, and what each makes stale (the table in api/invalidation.ts).
 *
 * The components change data through the useMutation hooks below, which refresh the queries the change
 * makes stale once it has been saved. Where the screen waited for that refresh before, their mutateAsync
 * settles after it; where it went on at once (a dialog closing, a status message), it settles as soon as
 * the change is saved, and the refresh follows. Code outside the components
 * (actions.ts, the memo pane's saves, the sticky notes' store) sends its requests itself and calls
 * invalidate with the same change, since it orders the refresh around its own steps: a change shown in
 * the paper's query before it is saved (tagQueue.ts, metadataSaver.ts), or an action on several papers
 * that holds the reloads until it is done (libraryRefresh.ts).
 */
import { useRef } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryClient as appQueryClient } from "@/lib/queryClient";
import type { StickyNote } from "@/features/reader/stickyNotes";
import type { PaperDomains } from "@/features/reader/glossaryDomains";
import type { Term } from "@/features/reader/translationStart";
import { api, unwrap } from "./client";
import { invalidationsFor, type DataChange } from "./invalidation";
import type { components } from "./schema";
import { tagChoicesEndpoint, type TagKind } from "./tagChoices";

type Schemas = components["schemas"];

export type { DataChange } from "./invalidation";

/** Refreshes what `change` makes stale; settles once the queries on screen have been fetched again. */
export async function invalidate(change: DataChange, client: QueryClient = appQueryClient): Promise<void> {
  await Promise.all(invalidationsFor(change).map((filters) => client.invalidateQueries(filters)));
}

// --- Papers ---------------------------------------------------------------------------------

/** PATCH /api/papers/{id}. What it makes stale is the caller's (a "paper" change, or the library after an action on several). */
export function patchPaper(paperId: string, body: Schemas["UpdatePaperRequest"]): Promise<unknown> {
  return unwrap(api.PATCH("/api/papers/{paper_id}", { params: { path: { paper_id: paperId } }, body }));
}

// --- Sticky notes ---------------------------------------------------------------------------

type StickyNoteFields = { page: number; side: "original" | "translated"; quote: string; anchor_y: number; anchor_x: number; label: string; note: string };

/**
 * A sticky note added (POST) or edited (PATCH, with `id`). mutateAsync settles once it is saved, so that
 * the dialog closes at once; `refreshed` settles once the notes have been loaded again after the last save.
 */
export function useSaveStickyNote() {
  const client = useQueryClient();
  const refresh = useRef<Promise<void>>(Promise.resolve());
  const mutation = useMutation({
    mutationFn: async ({ paperId, id, fields }: { paperId: string; id?: number; fields: StickyNoteFields }): Promise<StickyNote> => {
      const saved = id
        ? await unwrap(api.PATCH("/api/papers/{paper_id}/sticky-notes/{bookmark_id}", {
          params: { path: { paper_id: paperId, bookmark_id: id } },
          body: { label: fields.label, note: fields.note, anchor_y: fields.anchor_y, anchor_x: fields.anchor_x } }))
        : await unwrap(api.POST("/api/papers/{paper_id}/sticky-notes", { params: { path: { paper_id: paperId } }, body: fields }));
      return saved as StickyNote;
    },
    onSuccess: () => { refresh.current = invalidate({ kind: "stickyNote" }, client); },
  });
  return { ...mutation, refreshed: () => refresh.current };
}

/** A sticky note dragged to `position`: shown there at once in every list, then the lists are loaded again. */
export function useMoveStickyNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ item, position }: { item: StickyNote; position: { anchor_x: number; anchor_y: number } }): Promise<StickyNote> =>
      await unwrap(api.PATCH("/api/papers/{paper_id}/sticky-notes/{bookmark_id}", {
        params: { path: { paper_id: item.paper_id, bookmark_id: item.id } },
        body: { label: item.label, note: item.note, ...position } })) as StickyNote,
    onSuccess: (saved) => {
      showSavedStickyNote(client, saved);
      return invalidate({ kind: "stickyNoteMoved" }, client);
    },
  });
}

/** Puts a note as the sidecar answered it into the loaded lists, before they are loaded again. */
export function showSavedStickyNote(client: QueryClient, saved: StickyNote): void {
  client.setQueriesData<StickyNote[]>({ queryKey: invalidationsFor({ kind: "stickyNoteMoved" })[0].queryKey },
    (notes) => notes?.map((note) => note.id === saved.id ? { ...note, ...saved } : note));
}

// --- Tag choices ------------------------------------------------------------------------------

/** A choice of paper tag, reading status or sticky-note label added (`name`) or deleted (`remove`). */
export function useTagChoiceMutation(kind: TagKind) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: { name: string } | { remove: string }) => "remove" in change
      ? deleteTagChoice(kind, change.remove) : addTagChoice(kind, change.name),
    onSuccess: (_answer, change) => invalidate({ kind: "tagChoice", tagKind: kind, removed: "remove" in change }, client),
  });
}

function addTagChoice(kind: TagKind, name: string): Promise<unknown> {
  return unwrap(api.POST(tagChoicesEndpoint(kind), { body: { name } }));
}

function deleteTagChoice(kind: TagKind, name: string): Promise<unknown> {
  return unwrap(api.DELETE(tagChoicesEndpoint(kind), { params: { query: { name } } }));
}

// --- The common glossary ------------------------------------------------------------------------

/** GET /api/glossary. */
export async function fetchGlossary(): Promise<Term[]> {
  return await unwrap(api.GET("/api/glossary")) as Term[];
}

/** Saves the glossary as `terms`; refused when it is no longer `expected` (changed elsewhere meanwhile). */
export function useSaveGlossary() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ terms, expected }: { terms: Term[]; expected: Term[] }) =>
      unwrap(api.PUT("/api/glossary", { body: { terms, expected_terms: expected } })),
    onSuccess: () => invalidate({ kind: "glossary" }, client),
  });
}

/**
 * Registers one term for this paper, in its main domain (the new domain, else the first domain selected, else
 * 共通), replacing a term of the same source there (case aside); settles once saved with the domain it went to.
 */
export function useAddGlossaryTerm() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ paperId, source, target }: { paperId: string; source: string; target: string }): Promise<{ domain: string }> =>
      await unwrap(api.POST("/api/papers/{paper_id}/glossary/terms", {
        params: { path: { paper_id: paperId } }, body: { source, target } })) as { domain: string },
    onSuccess: () => { void invalidate({ kind: "glossary" }, client); },
  });
}

/** GET /api/papers/{id}/glossary-domains: the domain dictionaries this paper uses, and the ones there are. */
export async function fetchPaperDomains(paperId: string): Promise<PaperDomains> {
  return await unwrap(api.GET("/api/papers/{paper_id}/glossary-domains", { params: { path: { paper_id: paperId } } })) as PaperDomains;
}

/** Saves the domain dictionaries this paper uses (as chosen by the user); the sidecar keeps the names that exist. */
export function useSavePaperDomains() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ paperId, domains, newDomain }: { paperId: string; domains: string[]; newDomain: string | null }): Promise<PaperDomains> =>
      await unwrap(api.PUT("/api/papers/{paper_id}/glossary-domains", {
        params: { path: { paper_id: paperId } }, body: { domains, new_domain: newDomain } })) as PaperDomains,
    onSuccess: (_saved, { paperId }) => invalidate({ kind: "glossaryDomains", paperId }, client),
  });
}

// --- Note templates -------------------------------------------------------------------------------

export type NoteTemplate = { name: string; content: string; builtin: boolean };

const templatesKey = () => invalidationsFor({ kind: "noteTemplates" })[0].queryKey;

/** Saves a template (a new one, or over the one of that name): shown in the list at once, then the list is loaded again. */
export function useSaveNoteTemplate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (saved: NoteTemplate) => unwrap(api.PUT("/api/note-templates", { body: { name: saved.name, content: saved.content } })),
    onSuccess: (_answer, saved) => {
      client.setQueryData<NoteTemplate[]>(templatesKey(), (old) => [...(old ?? []).filter((item) => item.name !== saved.name), saved]);
      void invalidate({ kind: "noteTemplates" }, client);
    },
  });
}

export function useDeleteNoteTemplate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => unwrap(api.DELETE("/api/note-templates/{name}", { params: { path: { name } } })),
    onSuccess: (_answer, name) => {
      client.setQueryData<NoteTemplate[]>(templatesKey(), (old) => old?.filter((item) => item.name !== name) ?? []);
      void invalidate({ kind: "noteTemplates" }, client);
    },
  });
}

// --- Settings ---------------------------------------------------------------------------------------

/** Saves the connection settings and the prompts changed, whichever are given. */
export function useSaveSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ settings, prompts }: { settings?: Schemas["SettingsModel"]; prompts?: Record<string, string> }) => {
      if (settings) await unwrap(api.PUT("/api/settings", { body: settings }));
      if (prompts) await unwrap(api.PUT("/api/prompts", { body: prompts }));
    },
    onSuccess: () => invalidate({ kind: "settings" }, client),
  });
}
