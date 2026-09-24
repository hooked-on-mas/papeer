import React, { useState, useRef, useEffect } from "react";
import { useStore } from "@/store";
import { Send, MessageSquare } from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { api } from "@/api/client";
import { useMessages } from "@/api/hooks";
import { useQueryClient } from "@tanstack/react-query";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const EXAMPLE_QUESTIONS = [
  "この論文の主な貢献は何ですか？",
  "実験結果について詳しく教えてください。",
  "使用されているデータセットは何ですか？",
];

export function ChatPane() {
  const activePaperId = useStore((state) => state.activePaperId);
  const setCurrentPage = useStore((state) => state.setCurrentPage);
  const queryClient = useQueryClient();
  
  const { data: historyData } = useMessages(activePaperId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (historyData) {
      if (Array.isArray(historyData)) {
        setMessages(historyData as unknown as ChatMessage[]);
      } else if ((historyData as any).messages && Array.isArray((historyData as any).messages)) {
        setMessages((historyData as any).messages as ChatMessage[]);
      }
    } else {
      setMessages([]);
    }
  }, [historyData]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const handleSend = async (text: string) => {
    if (!text.trim() || !activePaperId || isLoading) return;
    
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsLoading(true);
    
    try {
      const { data, error } = await api.POST("/api/papers/{paper_id}/ask", {
        params: { path: { paper_id: activePaperId } },
        // @ts-expect-error schema body might be different, adapt based on schema.d.ts if known
        body: { question: text }
      });
      
      if (!error) {
        if (data && (data as any).answer) {
          setMessages((prev) => [...prev, { role: "assistant", content: (data as any).answer }]);
        } else if (typeof data === "string") {
          setMessages((prev) => [...prev, { role: "assistant", content: data }]);
        }
        queryClient.invalidateQueries({ queryKey: ["messages", activePaperId] });
      }
    } catch (e) {
      console.error("Failed to send message", e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  if (!activePaperId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 h-full">
        <p className="text-[15px] font-medium mb-1 text-foreground">論文が選択されていません</p>
        <p className="text-[13px]">左のライブラリから論文を選ぶか、PDF を追加してください</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-full bg-background overflow-hidden">
      <div className="h-[48px] flex items-center px-4 border-b shrink-0 bg-background/50">
        <h2 className="text-[14px] font-semibold flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-muted-foreground" />
          質問
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <MessageSquare className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <p className="text-sm font-medium mb-2">この論文について質問しましょう</p>
            <div className="flex flex-col gap-2 w-full max-w-sm mt-4">
              {EXAMPLE_QUESTIONS.map((q, i) => (
                <button
                  key={i}
                  onClick={() => handleSend(q)}
                  className="text-[13px] text-left px-4 py-2 border rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-lg px-4 py-3 text-[14px] ${
              msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
            }`}>
              <MarkdownRenderer 
                content={msg.content} 
                onCitationClick={(page) => setCurrentPage(page)}
              />
            </div>
          </div>
        ))}
        
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-muted text-foreground rounded-lg px-4 py-3 text-sm flex gap-1 items-center">
              <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" />
              <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      
      <div className="p-4 bg-background border-t shrink-0">
        <div className="relative max-w-3xl mx-auto flex items-end gap-2">
          <textarea
            className="flex-1 min-h-[44px] max-h-[200px] rounded-lg border border-input bg-background px-3 py-3 text-[13px] shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none leading-relaxed"
            placeholder="論文に関する質問を入力 (Enterで送信, Shift+Enterで改行)..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            className="flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 h-[44px] w-[44px] shrink-0 disabled:opacity-50 transition-opacity"
            onClick={() => handleSend(input)}
            disabled={isLoading || !input.trim()}
          >
            <Send className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
    </div>
  );
}
