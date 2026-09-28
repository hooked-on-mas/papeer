import { useQuery } from "@tanstack/react-query";
import { api, ApiError, unwrap } from "./client";
import type { components } from "./schema";
import { QK } from "@/lib/queryKeys";

type Schemas = components["schemas"];

/**
 * A paper's row as GET /api/papers lists it (PaperRow in sidecar/schemas/papers.py), with the memo
 * when it comes from GET /api/papers/{id} (Paper): the list rows leave the memo out.
 * status is the stored translation state, a code that storedStatusLabel (lib/paperStatus.ts) shows.
 */
export type PaperData = Schemas["PaperRow"] & { note?: string };

export type TranslatedPageRef = Schemas["TranslatedPageRef"] | null;

/** A paragraph typeset below the readable size because it overflowed its box (pdf_engine.build_translated_pdf). */
export type ReadabilityWarning = Schemas["ReadabilityWarning"];

/** translation-report.json as GET .../reading passes it on: an earlier Papeer's may lack any key. */
export type TranslationReport = Schemas["TranslationReport"];

export type GlossaryWarning = Schemas["GlossaryWarning"];

export type TranslationPreview = Schemas["TranslationPreview"];

/** A page needing OCR: kept as the original when its text layer is garbled or it is a scanned image,
 * or translated except for its garbled paragraphs ("partial"). */
export type OcrPage = Schemas["OcrPage"];

/** GET /api/papers/{id}/reading (ReadingState in sidecar/schemas/papers.py). */
export type ReadingData = Schemas["ReadingState"];

/** Settings of one AI connection, by provider id: cli_path, base_url, and the model/effort last chosen. */
export type ProviderOptions = Record<string, Record<string, string>>;

/** GET /api/settings; translation_concurrency 0 lets the sidecar decide (1 for a local model, else 3). */
export type SettingsData = Schemas["SettingsResponse"];

/** An AI connection as the sidecar describes it; the settings dialog is built from these. */
export type ProviderSpec = Schemas["ProviderSpecModel"];

export type ProviderOption = Schemas["ProviderOption"];

/** A chat message; a question has the passages sent with it, if any (PassageLocations). */
export type Message = Schemas["ChatMessage"];

/** GET /api/papers/{id}: the paper's row with its memo. */
export function getPaper(id: string): Promise<PaperData> {
  return unwrap(api.GET("/api/papers/{paper_id}", { params: { path: { paper_id: id } } }));
}

export function usePaper(id: string | null) {
  return useQuery({
    queryKey: [QK.papers, id],
    queryFn: async (): Promise<PaperData | null> => {
      if (!id) return null;
      return getPaper(id);
    },
    enabled: !!id,
    retry: false,
  });
}

export function usePaperList(query: string, sort: number) {
  return useQuery({
    queryKey: [QK.papers, "list", query, sort],
    queryFn: (): Promise<PaperData[]> => unwrap(api.GET("/api/papers", { params: { query: { query, sort } } })),
    placeholderData: (previous) => previous,
  });
}

export function useCollections() {
  return useQuery({
    queryKey: [QK.collections],
    queryFn: () => unwrap(api.GET("/api/collections")),
  });
}

export function useReading(id: string | null) {
  return useQuery({
    queryKey: [QK.reading, id],
    queryFn: async (): Promise<ReadingData | null> => {
      if (!id) return null;
      return unwrap(api.GET("/api/papers/{paper_id}/reading", { params: { path: { paper_id: id } } }));
    },
    enabled: !!id,
    retry: false,
  });
}

export function useArticle(id: string | null) {
  return useQuery({
    queryKey: [QK.article, id],
    queryFn: async () => {
      if (!id) return null;
      try {
        return await unwrap(api.GET("/api/papers/{paper_id}/article", { params: { path: { paper_id: id } } }));
      } catch (error) {
        // 404: no summary has been generated yet, which is not an error.
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: !!id,
    retry: false,
  });
}

export function useMessages(id: string | null) {
  return useQuery({
    queryKey: [QK.messages, id],
    queryFn: async (): Promise<Message[]> => {
      if (!id) return [];
      return unwrap(api.GET("/api/papers/{paper_id}/messages", { params: { path: { paper_id: id } } }));
    },
    enabled: !!id,
  });
}

export function useSettings(enabled = true) {
  return useQuery({
    queryKey: [QK.settings],
    queryFn: () => unwrap(api.GET("/api/settings")),
    enabled,
  });
}

/** Plan usage of the connected AI; refreshed after each AI job. null when the service reports none. */
export function useUsageLimits(provider: string | undefined) {
  return useQuery({
    queryKey: [QK.usageLimits, provider],
    queryFn: () => unwrap(api.GET("/api/usage/limits")),
    enabled: !!provider,
    staleTime: 5 * 60_000,
    // Unlike the rest (App.tsx): usage goes on in other apps and devices. At most every staleTime.
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: [QK.health],
    queryFn: () => unwrap(api.GET("/health")),
    staleTime: Infinity,
  });
}

/** "Smith (2024) Title", as the old library and header labelled papers. */
export function paperDisplayName(paper: Pick<PaperData, "title" | "original_name" | "first_author" | "publication_year">): string {
  const author = (paper.first_author || "").trim();
  const year = (paper.publication_year || "").trim();
  const prefix = [author, year ? `(${year})` : ""].filter(Boolean).join(" ");
  const title = paper.title || paper.original_name || "";
  return prefix ? `${prefix} ${title}` : title;
}

export function useProviders() {
  return useQuery({
    queryKey: [QK.providers],
    queryFn: () => unwrap(api.GET("/api/providers")),
    staleTime: Infinity,
  });
}

export function providerLabel(providers: ProviderSpec[] | undefined, id: string | undefined): string {
  if (!id) return "";
  return providers?.find((p) => p.id === id)?.label ?? id;
}

/** Models the connection offers; cliPath (unsaved in the dialog) overrides the saved path. */
export function useProviderModels(provider: string, options: { cliPath?: string; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [QK.models, provider, options.cliPath ?? null],
    // cli_path is left out, rather than sent empty, when undefined: then the saved path is used.
    queryFn: () => unwrap(api.GET("/api/providers/{provider}/models", {
      params: { path: { provider }, query: { cli_path: options.cliPath } } })),
    enabled: (options.enabled ?? true) && !!provider,
    staleTime: 5 * 60_000,
  });
}

export function useProviderEfforts(provider: string, model: string, options: { cliPath?: string; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [QK.efforts, provider, model, options.cliPath ?? null],
    queryFn: () => unwrap(api.GET("/api/providers/{provider}/efforts", {
      params: { path: { provider }, query: { model, cli_path: options.cliPath } } })),
    enabled: (options.enabled ?? true) && !!provider,
    staleTime: 5 * 60_000,
  });
}
