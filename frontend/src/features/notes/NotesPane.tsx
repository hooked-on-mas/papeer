import { useState, useEffect } from "react";
import { useStore } from "@/store";
import { NotebookPen, Save } from "lucide-react";
import { api } from "@/api/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export function NotesPane() {
  const activePaperId = useStore((state) => state.activePaperId);
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");

  const { data: paper } = useQuery({
    queryKey: ["papers", activePaperId],
    queryFn: async () => {
      if (!activePaperId) return null;
      const { data } = await api.GET("/api/papers/{paper_id}", {
        params: { path: { paper_id: activePaperId } },
      });
      return data;
    },
    enabled: !!activePaperId,
  });

  useEffect(() => {
    if (paper && (paper as any).notes) {
      setContent((paper as any).notes);
    } else {
      setContent("");
    }
  }, [paper, activePaperId]);

  const saveMutation = useMutation({
    mutationFn: async (newNotes: string) => {
      if (!activePaperId) return;
      // We would ideally PATCH the notes.
      // @ts-expect-error notes schema
      await api.PUT(`/api/papers/${activePaperId}/notes`, {
        body: { notes: newNotes }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["papers", activePaperId] });
    }
  });

  if (!activePaperId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 h-full">
        <p className="text-[15px] font-medium mb-1 text-foreground">論文が選択されていません</p>
        <p className="text-[13px]">左のライブラリから論文を選ぶか、PDF を追加してください</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-background overflow-hidden">
      <div className="h-[48px] flex items-center justify-between px-4 border-b shrink-0 bg-background/50">
        <h2 className="text-[14px] font-semibold flex items-center gap-2">
          <NotebookPen className="w-4 h-4 text-muted-foreground" />
          メモ・整理
        </h2>
        <button 
          onClick={() => saveMutation.mutate(content)}
          disabled={saveMutation.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <Save className="w-3.5 h-3.5" />
          {saveMutation.isPending ? "保存中..." : "保存"}
        </button>
      </div>
      
      <div className="flex-1 p-4 flex flex-col">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="論文に関するメモを自由に記述できます..."
          className="flex-1 w-full p-4 text-[14px] leading-relaxed resize-none border rounded-lg focus:outline-none focus:ring-1 focus:ring-ring bg-transparent"
        />
      </div>
    </div>
  );
}
