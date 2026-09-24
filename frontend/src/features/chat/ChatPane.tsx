import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { useStore } from "@/store";
import { Send } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export function ChatPane() {
  const activePaperId = useStore((state) => state.activePaperId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activePaperId) {
      loadHistory();
    } else {
      setMessages([]);
    }
  }, [activePaperId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadHistory = async () => {
    if (!activePaperId) return;
    try {
      const port = import.meta.env.VITE_PAPERDESK_PORT || 1420;
      const token = import.meta.env.VITE_PAPERDESK_TOKEN || "";
      const res = await fetch(`http://127.0.0.1:${port}/api/papers/${activePaperId}/chat`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setMessages(data);
        } else if (data && Array.isArray(data.messages)) {
          setMessages(data.messages);
        }
      }
    } catch (e) {
      console.error("Failed to load chat history", e);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !activePaperId || isLoading) return;
    
    const userMessage = input;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setIsLoading(true);
    
    try {
      const port = import.meta.env.VITE_PAPERDESK_PORT || 1420;
      const token = import.meta.env.VITE_PAPERDESK_TOKEN || "";
      const res = await fetch(`http://127.0.0.1:${port}/api/papers/${activePaperId}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ message: userMessage })
      });
      
      if (res.ok) {
        const data = await res.json();
        if (data.message) {
            setMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
        } else if (data.content) {
            setMessages((prev) => [...prev, { role: "assistant", content: data.content }]);
        } else if (typeof data === "string") {
            setMessages((prev) => [...prev, { role: "assistant", content: data }]);
        } else {
            await loadHistory();
        }
      } else {
        console.error("Error from server", res.status);
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
      handleSend();
    }
  };

  if (!activePaperId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Select a paper to start chatting.
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-full bg-background">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-lg p-3 ${
              msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
            }`}>
              <div className="prose dark:prose-invert max-w-none text-sm break-words">
                <ReactMarkdown>
                  {msg.content}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-muted text-foreground rounded-lg p-3 text-sm flex gap-1 items-center">
              <span className="animate-pulse">.</span>
              <span className="animate-pulse delay-75">.</span>
              <span className="animate-pulse delay-150">.</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      
      <div className="p-4 border-t bg-background shrink-0">
        <div className="flex gap-2">
          <textarea
            className="flex-1 min-h-[40px] max-h-[120px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
            placeholder="Ask about this paper..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 w-10 shrink-0"
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
