import { useQuery, useMutation } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { RefreshCw } from "lucide-react";
import { useStore } from "../../store";
import { api } from "../../api/client";
import { Button } from "@/components/ui/button";

export function SummaryPane() {
  const activePaperId = useStore((state) => state.activePaperId);

  const { data, isLoading, error } = useQuery({
    queryKey: ["summary", activePaperId],
    queryFn: async () => {
      if (!activePaperId) return null;
      // @ts-expect-error: schema might not have the summary endpoints yet
      const { data, error } = await api.GET("/api/papers/{paper_id}/summary", {
        params: { path: { paper_id: activePaperId } },
      });
      if (error) throw new Error((error as any).message || JSON.stringify(error) || "Failed to fetch summary");
      return data;
    },
    enabled: !!activePaperId,
  });

  const summarizeMutation = useMutation({
    mutationFn: async () => {
      if (!activePaperId) return;
      // @ts-expect-error: schema might not have the summary endpoints yet
      const { data, error } = await api.POST("/api/papers/{paper_id}/summarize", {
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
      <div className="flex-1 flex items-center justify-center text-muted-foreground p-4 h-full">
        Select a paper to view its summary
      </div>
    );
  }

  const summaryText = (data as any)?.summary || (typeof data === "string" ? data : "");

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b shrink-0">
        <h2 className="text-lg font-semibold">Summary</h2>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => summarizeMutation.mutate()}
          disabled={summarizeMutation.isPending}
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${summarizeMutation.isPending ? "animate-spin" : ""}`} />
          {summarizeMutation.isPending ? "Generating..." : "Generate Summary"}
        </Button>
      </div>
      
      <div className="flex-1 overflow-auto p-4">
        <div className="prose dark:prose-invert max-w-none">
          {isLoading && <div className="text-muted-foreground">Loading summary...</div>}
          {error && <div className="text-destructive">Error: {error.message}</div>}
          {!isLoading && !error && summaryText ? (
            <ReactMarkdown>{summaryText}</ReactMarkdown>
          ) : (
            !isLoading && !error && <div className="text-muted-foreground">No summary available. Click "Generate Summary" to create one.</div>
          )}
        </div>
      </div>
    </div>
  );
}
