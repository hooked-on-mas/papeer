import { useMutation } from "@tanstack/react-query";
import { RefreshCw, List } from "lucide-react";
import { useStore } from "../../store";
import { useArticle } from "../../api/hooks";
import { api } from "../../api/client";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";

export function SummaryPane() {
  const activePaperId = useStore((state) => state.activePaperId);
  const setCurrentPage = useStore((state) => state.setCurrentPage);

  const { data: article, isLoading, error } = useArticle(activePaperId);

  const summarizeMutation = useMutation({
    mutationFn: async () => {
      if (!activePaperId) return;
      const { data, error } = await api.POST("/api/papers/{paper_id}/article", {
        params: { path: { paper_id: activePaperId } },
      });
      if (error) throw new Error((error as any).message || JSON.stringify(error) || "Failed to trigger summary");
      return data;
    },
    onSuccess: (data: any) => {
      console.log("Summarization triggered, job ID:", data?.job_id);
    },
  });

  if (!activePaperId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 h-full">
        <p className="text-[15px] font-medium mb-1 text-foreground">サマリーがありません</p>
        <p className="text-[13px]">論文を選択してください</p>
      </div>
    );
  }

  const summaryText = typeof article === "string" ? article : (article as any)?.content || (article as any)?.summary || "";

  return (
    <div className="flex flex-col h-full w-full bg-background overflow-hidden">
      <div className="h-[48px] flex items-center justify-between px-4 border-b shrink-0 bg-background/50">
        <h2 className="text-[14px] font-semibold flex items-center gap-2">
          <List className="w-4 h-4 text-muted-foreground" />
          サマリー
        </h2>
        <button 
          onClick={() => summarizeMutation.mutate()}
          disabled={summarizeMutation.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${summarizeMutation.isPending ? "animate-spin" : ""}`} />
          {summarizeMutation.isPending ? "生成中..." : "サマリー生成"}
        </button>
      </div>
      
      <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto w-full">
        {isLoading && <div className="text-muted-foreground text-sm flex items-center gap-2"><RefreshCw className="w-4 h-4 animate-spin" /> サマリーを読み込み中...</div>}
        {error && <div className="text-destructive text-sm p-4 border rounded bg-destructive/10">エラーが発生しました: {error.message}</div>}
        
        {!isLoading && !error && summaryText ? (
          <MarkdownRenderer 
            content={summaryText} 
            onCitationClick={(page) => setCurrentPage(page)}
          />
        ) : (
          !isLoading && !error && (
            <div className="text-center py-12">
              <p className="text-muted-foreground text-sm mb-4">まだサマリーが生成されていません。</p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
