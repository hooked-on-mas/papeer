import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export type PaperData = {
  id: string;
  title: string;
  first_author?: string;
  publication_year?: string;
  collection_name?: string;
  has_article?: boolean;
};

export type ReadingData = {
  completed_pages?: number[];
  has_translated?: boolean;
};

export function usePaper(id: string | null) {
  return useQuery({
    queryKey: ["papers", id],
    queryFn: async (): Promise<PaperData | null> => {
      if (!id) return null;
      const { data, error } = await api.GET("/api/papers/{paper_id}", {
        params: { path: { paper_id: id } },
      });
      if (error) throw error;
      return data as unknown as PaperData;
    },
    enabled: !!id,
  });
}

export function useReading(id: string | null) {
  return useQuery({
    queryKey: ["reading", id],
    queryFn: async (): Promise<ReadingData | null> => {
      if (!id) return null;
      const { data, error } = await api.GET("/api/papers/{paper_id}/reading", {
        params: { path: { paper_id: id } },
      });
      if (error) throw error;
      return data as unknown as ReadingData;
    },
    enabled: !!id,
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
        // openapi-fetch: res.response.status has the HTTP code
        if (res.response?.status === 404) return null;
        throw res.error;
      }
      return res.data;
    },
    enabled: !!id,
    retry: false,
  });
}

export function useMessages(id: string | null) {
  return useQuery({
    queryKey: ["messages", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await api.GET("/api/papers/{paper_id}/messages", {
        params: { path: { paper_id: id } },
      });
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });
}
