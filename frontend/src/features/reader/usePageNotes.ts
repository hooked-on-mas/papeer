import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { QK } from "@/lib/queryKeys";
import type { StickyNote } from "./stickyNotes";

// Stable while the notes are loading or failed: a new array would redraw the text layer on every render.
const NO_NOTES: StickyNote[] = [];

/** The sticky notes and highlights of the item on `page`, apart by the side they are on. */
export function usePageNotes(paperId: string | null, page: number): { original: StickyNote[]; translated: StickyNote[] } {
  const { data: notes = NO_NOTES } = useQuery({
    queryKey: [QK.stickyNotes, paperId],
    queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/sticky-notes", {
      params: { path: { paper_id: paperId as string } } })) as StickyNote[],
    enabled: !!paperId,
  });
  const original = useMemo(() => notes.filter(item => item.page === page && item.side === "original"), [notes, page]);
  const translated = useMemo(() => notes.filter(item => item.page === page && item.side === "translated"), [notes, page]);
  return { original, translated };
}
