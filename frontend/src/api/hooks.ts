import { useQuery } from "@tanstack/react-query";
import { api, apiRequest } from "./client";
import type { Usage, UsageLimits } from "@/lib/usage";
import type { PassageLocation } from "@/store";

export type PaperData = {
  id: string;
  title: string;
  original_name?: string;
  first_author?: string;
  publication_year?: string;
  collection_name?: string;
  note?: string;
  tags?: string[];
  read_status?: string;
  status?: string;
  has_article?: boolean;
  has_translated?: boolean;
  translated_count?: number;
  translation_required_count?: number;
  translation_completed_required_count?: number;
  translation_has_issues?: boolean | null;
  translation_in_progress?: boolean;
  pages?: number;
  folder_path?: string;
  created_at?: string;
};

export type TranslatedPageRef = { file: string; index: number; mtime: number } | null;

export type TranslationReport = {
  pages?: number;
  selected_pages?: number[];
  translated_pages?: number[];
  skipped_pages?: number[];
  scaled_blocks?: number;
  readability_warnings?: { page: number }[];
  skipped_blocks?: string[];
};

export type TranslationPreview = {
  run_id: string;
  complete: boolean;
  pages: number[];
  target_pages?: number[];
  skipped_pages?: number[];
  total_pages?: number;
  page_errors?: Record<string, string>;
};

export type ReadingData = {
  page_count: number;
  source_page_count: number;
  empty_pages: number[];
  translation_required_pages?: number[];
  completed_pages: number[];
  preview: TranslationPreview | null;
  in_progress: boolean;
  report: TranslationReport | null;
  translated_pages: Record<string, TranslatedPageRef>;
  page_versions: Record<string, { sha: string; model: string }>;
  last_page: number;
  has_translated: boolean;
  has_article: boolean;
  has_interleaved: boolean;
  original_mtime: number;
};

export type SettingsData = {
  provider: string;
  model: string;
  reasoning_effort: string;
  api_base: string;
  codex_path: string;
  claude_path: string;
  gemini_path: string;
  /** 0 lets the sidecar decide: 1 for a local model, else 3. */
  translation_concurrency: number;
  api_key?: string | null;
};

export type Message = { role: "user" | "assistant"; content: string; usage?: Usage | null; attachments?: PassageLocation[] };

export function usePaper(id: string | null) {
  return useQuery({
    queryKey: ["papers", id],
    queryFn: async (): Promise<PaperData | null> => {
      if (!id) return null;
      return apiRequest<PaperData>("GET", `/api/papers/${id}`);
    },
    enabled: !!id,
    retry: false,
  });
}

export function usePaperList(query: string, sort: number) {
  return useQuery({
    queryKey: ["papers", "list", query, sort],
    queryFn: () => apiRequest<PaperData[]>(
      "GET", `/api/papers?query=${encodeURIComponent(query)}&sort=${sort}`),
    placeholderData: (previous) => previous,
  });
}

export function useCollections() {
  return useQuery({
    queryKey: ["collections"],
    queryFn: () => apiRequest<string[]>("GET", "/api/collections"),
  });
}

export function useReading(id: string | null) {
  return useQuery({
    queryKey: ["reading", id],
    queryFn: async (): Promise<ReadingData | null> => {
      if (!id) return null;
      return apiRequest<ReadingData>("GET", `/api/papers/${id}/reading`);
    },
    enabled: !!id,
    retry: false,
  });
}

export function useArticle(id: string | null) {
  return useQuery({
    queryKey: ["article", id],
    queryFn: async () => {
      if (!id) return null;
      const res = await api.GET("/api/papers/{paper_id}/article", {
        params: { path: { paper_id: id } },
      });
      // 404 means article hasn't been generated yet - return null, not an error
      if (res.error) {
        if (res.response?.status === 404 || (res.error as any).status === 404) return null;
        throw new Error((res.error as any).detail || JSON.stringify(res.error));
      }
      return res.data as unknown as { content: string; usage?: Usage | null };
    },
    enabled: !!id,
    retry: false,
  });
}

export function useMessages(id: string | null) {
  return useQuery({
    queryKey: ["messages", id],
    queryFn: async (): Promise<Message[]> => {
      if (!id) return [];
      return apiRequest<Message[]>("GET", `/api/papers/${id}/messages`);
    },
    enabled: !!id,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => apiRequest<SettingsData>("GET", "/api/settings"),
  });
}

/** Plan usage of the connected AI; refreshed after each AI job. null when the service reports none. */
export function useUsageLimits(provider: string | undefined) {
  return useQuery({
    queryKey: ["usage-limits", provider],
    queryFn: () => apiRequest<UsageLimits | null>("GET", "/api/usage/limits"),
    enabled: !!provider,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => apiRequest<{ version: string; code_version: string }>("GET", "/health"),
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

export const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Google Gemini (agy CLI)",
  claude: "Claude Code CLI",
  codex: "ChatGPT / Codex CLI",
  api: "API / ローカルモデル（OpenAI互換）",
};
