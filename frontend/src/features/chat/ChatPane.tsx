import React, { useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, Send, Square } from "lucide-react";
import { isRunning, paperBusy, useStore } from "@/store";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { UsageLine } from "@/components/UsageLine";
import { apiRequest } from "@/api/client";
import { useMessages } from "@/api/hooks";
import { showError, startJob } from "@/features/jobs/jobEvents";

const EXAMPLE_QUESTIONS = [
  "従来手法と比べた改善点は？",
  "手法の前提条件と、実験の条件は？",
  "限界と今後の課題は？",
];

export function ChatPane() {
  const activePaperId = useStore((state) => state.activePaperId);
  const activeJobs = useStore((state) => state.activeJobs);
  const { data: messages = [] } = useMessages(activePaperId);
  const [input, setInput] = useState("");
  const [allPapers, setAllPapers] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const askJob = activeJobs.find((j) => j.paper_id === activePaperId && isRunning(j) && j.kind === "ask");
  const busy = paperBusy(activeJobs, activePaperId);

  // Only on a real paper switch: a StrictMode rerun on mount would wipe a draft from the reader.
  const shownPaperId = useRef(activePaperId);
  useEffect(() => {
    if (shownPaperId.current === activePaperId) return;
    shownPaperId.current = activePaperId;
    setPending(null);
    setInput("");
  }, [activePaperId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, askJob, pending, activePaperId]);

  useEffect(() => {
    // Grow with the text up to about six lines.
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
    el.style.overflowY = el.scrollHeight > 150 ? "auto" : "hidden";
  }, [input]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || !activePaperId || busy) return;
    const paperId = activePaperId;
    setPending(question);
    try {
      await startJob(`/api/papers/${paperId}/ask`, { question, search_all: allPapers },
        { kind: "ask", paperId },
        (event) => {
          if (useStore.getState().activePaperId !== paperId) return;
          setPending(null);
          // Keep the question for another try unless it was answered.
          if (event.status === "succeeded") setInput((current) => current.trim() === question ? "" : current);
        });
    } catch (error) {
      setPending(null);
      showError(error, "質問を送信できませんでした");
    }
  };

  // Text from the reader's context menu: ask at once, or leave it in the input to finish the question.
  const chatDraft = useStore((state) => state.chatDraft);
  useEffect(() => {
    // Take it from the store, not the render: StrictMode reruns this effect and must not ask twice.
    const draft = useStore.getState().chatDraft;
    if (!draft) return;
    useStore.getState().setChatDraft(null);
    if (draft.paperId !== activePaperId) return;
    if (draft.send && !busy && !askJob && pending === null) {
      send(draft.text);
      return;
    }
    setInput(draft.text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }, [chatDraft, activePaperId]);

  const handleKeyDown =(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
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

  const waiting = !!askJob || pending !== null;

  return (
    <div className="flex flex-col w-full h-full bg-background overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          {messages.length === 0 && !waiting && (
            <div className="flex flex-col items-center justify-center text-center py-12">
              <MessageSquare className="w-12 h-12 text-muted-foreground/30 mb-4" />
              <p className="text-[15px] font-medium mb-1">本文を根拠に、質問する</p>
              <p className="text-[13px] text-muted-foreground">手法の違い、実験条件、限界などを聞いてみてください。</p>
              <div className="flex flex-wrap justify-center gap-2 mt-5">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => { setInput(q); inputRef.current?.focus(); }}
                    className="text-[13px] px-3 py-1.5 border rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => msg.role === "user" ? (
            <div key={idx}>
              <div className="text-[12px] font-medium text-muted-foreground mb-1">あなた</div>
              <div className="rounded-lg bg-muted/60 border px-4 py-2.5 text-[14px] whitespace-pre-wrap">{msg.content}</div>
            </div>
          ) : (
            <div key={idx}>
              <div className="text-[12px] font-medium text-muted-foreground mb-1">回答</div>
              <MarkdownRenderer content={msg.content} paperId={activePaperId} className="max-w-none" />
              <UsageLine usage={msg.usage} className="mt-2" />
            </div>
          ))}

          {waiting && (
            <>
              {pending && (
                <div>
                  <div className="text-[12px] font-medium text-muted-foreground mb-1">あなた</div>
                  <div className="rounded-lg bg-muted/60 border px-4 py-2.5 text-[14px] whitespace-pre-wrap">{pending}</div>
                </div>
              )}
              <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="truncate">{askJob?.message || "回答を作成中…"}</span>
                {askJob && (
                  <button
                    onClick={() => apiRequest("POST", `/api/jobs/${askJob.job_id}/cancel`).catch(() => undefined)}
                    className="flex items-center gap-1 px-2 py-1 rounded border text-[12px] hover:bg-muted"
                  >
                    <Square className="w-3 h-3" /> 中止
                  </button>
                )}
              </div>
            </>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="px-4 pt-3 pb-2 bg-background border-t shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              className="flex-1 min-h-[40px] rounded-lg border border-input bg-background px-3 py-2.5 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none leading-relaxed disabled:opacity-60"
              placeholder="例：従来手法と比べた改善点と、実験の限界は？"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={waiting}
              rows={1}
            />
            <button
              className="flex items-center gap-1.5 justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 h-[40px] px-4 shrink-0 disabled:opacity-50 transition-opacity text-[13px] font-medium"
              onClick={() => send(input)}
              disabled={busy || waiting || !input.trim()}
            >
              <Send className="w-4 h-4" /> 質問する
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 mt-1.5 text-[12px] text-muted-foreground">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={allPapers} onChange={(e) => setAllPapers(e.target.checked)} />
              保存したほかの論文も検索する
            </label>
            <span>Enter: 送信 / Shift+Enter: 改行</span>
          </div>
        </div>
      </div>
    </div>
  );
}
