import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { QK } from "@/lib/queryKeys";
import type { components } from "@/api/schema";

export type ResearchRecord = components["schemas"]["ResearchRecord"];

export function useResearch(source: string | null) {
  return useQuery({
    queryKey: [QK.research, source],
    queryFn: () => unwrap(api.GET("/api/papers/{paper_id}/reference-research", { params: { path: { paper_id: source! } } })),
    enabled: !!source && /^[0-9a-f]{32}$/.test(source),
  });
}

export function useWebSearchCapability() {
  return useQuery({
    queryKey: [QK.settings, QK.researchCapabilities],
    queryFn: () => unwrap(api.GET("/api/research-capabilities")),
  });
}
