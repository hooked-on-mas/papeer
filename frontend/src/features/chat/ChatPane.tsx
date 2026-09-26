import React, { useEffect, useRef, useState } from "react";
import { FileText, Loader2, MessageSquare, Send, Square, X } from "lucide-react";
import { isRunning, paperBusy, useStore, type PassageAttachment, type PassageLocation } from "@/store";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { UsageLine } from "@/components/UsageLine";
import { apiRequest } from "@/api/client";
import { useCollections, useMessages, usePaperList } from "@/api/hooks";
import { showError, startJob } from "@/features/jobs/jobEvents";
import { showPassage } from "@/features/reader/navigation";
import { CitationEvidence } from "./CitationEvidence";

const EXAMPLE_QUESTIONS = [
  "従来手法と比べた改善点は？",
  "手法の前提条件と、実験の条件は？",
  "限界と今後の課題は？",
];

/** Sent when passages are attached but nothing is typed. */
const EXPLAIN_ATTACHED = "添付した箇所をわかりやすく説明してください。";

/** A passage attached to a message: its page and first words; opens the PDF there, selected. */
function AttachmentChip({ passage, paperId, onRemove }: {
  passage: PassageLocation;
  paperId: string;
  onRemove?: () => void;
}) {
  const side = passage.side === "translated" ? "訳" : "";
  return (
    <span className="inline-flex max-w-full items-center rounded-md border bg-background text-[12px] text-muted-foreground">
      <button
        type="button"
        onClick={() => showPassage(paperId, passage)}
        title={`${passage.text.slice(0, 300)}${passage.text.length > 300 ? "…" : ""}\n\nクリックで PDF のこの箇所を表示`}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted hover:text-foreground"
      >
        <FileText className="w-3.5 h-3.5 shrink-0" />
        <span className="shrink-0 font-medium">p.{passage.page}{side}</span>
        <span className="truncate max-w-[16rem]">{passage.text}</span>
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} title="添付を外す" className="mr-1 rounded p-0.5 hover:bg-muted hover:text-foreground">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

function AttachmentList({ attachments, paperId, onRemove }: {
  attachments: PassageLocation[];
  paperId: string;
  onRemove?: (index: number) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((passage, index) => (
        <AttachmentChip key={index} passage={passage} paperId={paperId} onRemove={onRemove && (() => onRemove(index))} />
      ))}
    </div>
  );
}

/** The API's form of an attachment, without the ids kept only in the input. */
function toLocation({ id: _id, paperId: _paperId, ...passage }: PassageAttachment): PassageLocation {
  return passage;
}

export function ChatPane() {
  const activePaperId = useStore((state) => state.activePaperId);
  const activeJobs = useStore((state) => state.activeJobs);
  const { data: messages = [] } = useMessages(activePaperId);
  // Kept in the store: attaching passages means leaving this tab for the reader and coming back.
  const input = useStore((state) => (activePaperId && state.chatInputs[activePaperId]) || "");
  const setInput = (text: string) => { if (activePaperId) useStore.getState().setChatInput(activePaperId, text); };
  const allAttachments = useStore((state) => state.chatAttachments);
  const attachments = allAttachments.filter((item) => item.paperId === activePaperId);
  const [scope, setScope] = useState<"paper" | "selected" | "collection">("paper");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [collection, setCollection] = useState("");
  const [referencePages, setReferencePages] = useState("");
  const [retrievalQuery, setRetrievalQuery] = useState("");
  const [maxPages, setMaxPages] = useState(10);
  const { data: papers = [] } = usePaperList("", 0);
  const { data: collections = [] } = useCollections();
  const [pending, setPending] = useState<{ question: string; attachments: PassageLocation[] } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const askJob = activeJobs.find((j) => j.paper_id === activePaperId && isRunning(j) && j.kind === "ask");
  const busy = paperBusy(activeJobs, activePaperId);

  // Only on a real paper switch: a StrictMode rerun on mount would drop a message from the reader.
  const shownPaperId = useRef(activePaperId);
  useEffect(() => {
    if (shownPaperId.current === activePaperId) return;
    shownPaperId.current = activePaperId;
    setPending(null);
    setReferencePages(""); setRetrievalQuery("");
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

  const send = async (text: string, attached: PassageAttachment[] = attachments) => {
    const question = text.trim() || (attached.length ? EXPLAIN_ATTACHED : "");
    if (!question || !activePaperId || busy || (scope === "selected" && !selectedIds.length)) return;
    const paperId = activePaperId;
    const passages = attached.map(toLocation);
    setPending({ question, attachments: passages });
    try {
      await startJob(`/api/papers/${paperId}/ask`,
        { question, attachments: passages, scope, paper_ids: selectedIds, collection,
          reference_pages: referencePages, retrieval_query: retrievalQuery, max_pages: maxPages },
        { kind: "ask", paperId },
        (event) => {
          if (useStore.getState().activePaperId !== paperId) return;
          setPending(null);
          // Keep the message and its passages for another try unless it was answered.
          if (event.status !== "succeeded") return;
          const store = useStore.getState();
          if ((store.chatInputs[paperId] ?? "").trim() === text.trim()) store.setChatInput(paperId, "");
          store.removeChatAttachments(attached.map((item) => item.id));
        });
    } catch (error) {
      setPending(null);
      showError(error, "メッセージを送信できませんでした");
    }
  };

  // From the reader's context menu: a request to explain a passage, sent at once.
  const chatDraft = useStore((state) => state.chatDraft);
  useEffect(() => {
    // Take it from the store, not the render: StrictMode reruns this effect and must not send twice.
    const store = useStore.getState();
    const draft = store.chatDraft;
    if (!draft) return;
    store.setChatDraft(null);
    if (draft.paperId !== activePaperId) return;
    if (draft.send && !busy && !askJob && pending === null) {
      send(draft.text, draft.attachments ?? []);
      return;
    }
    // Busy with another answer: leave it in the input to send later.
    draft.attachments?.forEach(store.addChatAttachment);
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
              <p className="text-[15px] font-medium mb-1">本文を根拠に、チャットする</p>
              <p className="text-[13px] text-muted-foreground">手法の違い、実験条件、限界などを聞いてみてください。</p>
              <p className="text-[13px] text-muted-foreground">PDF で文章を選び、右クリック →「この箇所をチャットに添付」で箇所を添えられます。</p>
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
              <div className="rounded-lg bg-muted/60 border px-4 py-2.5 text-[14px] space-y-2">
                <AttachmentList attachments={msg.attachments ?? []} paperId={activePaperId} />
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>
            </div>
          ) : (
            <div key={idx}>
              <div className="text-[12px] font-medium text-muted-foreground mb-1">回答</div>
              <MarkdownRenderer content={msg.content} paperId={activePaperId} className="max-w-none" />
              <CitationEvidence content={msg.content} />
              <UsageLine usage={msg.usage} className="mt-2" />
            </div>
          ))}

          {waiting && (
            <>
              {pending && (
                <div>
                  <div className="text-[12px] font-medium text-muted-foreground mb-1">あなた</div>
                  <div className="rounded-lg bg-muted/60 border px-4 py-2.5 text-[14px] space-y-2">
                    <AttachmentList attachments={pending.attachments} paperId={activePaperId} />
                    <div className="whitespace-pre-wrap">{pending.question}</div>
                  </div>
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
          {attachments.length > 0 && (
            <div className="mb-2">
              <AttachmentList attachments={attachments} paperId={activePaperId}
                onRemove={waiting ? undefined : (index) => useStore.getState().removeChatAttachments([attachments[index].id])} />
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              className="flex-1 min-h-[40px] rounded-lg border border-input bg-background px-3 py-2.5 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none leading-relaxed disabled:opacity-60"
              placeholder={attachments.length
                ? "添付した箇所について入力（空欄のまま送ると説明を求めます）"
                : "例：従来手法と比べた改善点と、実験の限界は？"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={waiting}
              rows={1}
            />
            <button
              className="flex items-center gap-1.5 justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 h-[40px] px-4 shrink-0 disabled:opacity-50 transition-opacity text-[13px] font-medium"
              onClick={() => send(input)}
              disabled={busy || waiting || (!input.trim() && !attachments.length) || (scope === "selected" && !selectedIds.length)}
            >
              <Send className="w-4 h-4" /> 送信
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 mt-1.5 text-[12px] text-muted-foreground">
            <label className="flex items-center gap-1.5">参照範囲
              <select className="border rounded bg-background px-1" value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
                <option value="paper">この論文</option><option value="selected">選んだ論文</option><option value="collection">フォルダー内</option>
              </select>
            </label>
            <span>Enter: 送信 / Shift+Enter: 改行</span>
          </div>
          {scope === "selected" && <div className="mt-2 max-h-28 overflow-auto border rounded p-2 grid grid-cols-2 gap-1 text-xs">
            {papers.map(paper => <label key={paper.id} className="flex gap-1 items-center truncate"><input type="checkbox" checked={selectedIds.includes(paper.id)} onChange={e => setSelectedIds(ids => e.target.checked ? [...ids, paper.id] : ids.filter(id => id !== paper.id))} /><span className="truncate" title={paper.title}>{paper.title}</span></label>)}
          </div>}
          {scope === "collection" && <select className="mt-2 w-full border rounded bg-background px-2 py-1 text-xs" value={collection} onChange={e => setCollection(e.target.value)}>
            <option value="">未分類</option>{collections.filter(Boolean).map(name => <option key={name} value={name}>{name}</option>)}
          </select>}
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">参照ページの追加・検索条件</summary>
            <div className="grid grid-cols-[100px_1fr] items-center gap-2 mt-2">
              <label htmlFor="chat-extra-pages">この論文の追加ページ</label><input id="chat-extra-pages" disabled={waiting} className="border rounded bg-background px-2 py-1" placeholder="例：3, 5-8" value={referencePages} onChange={e => setReferencePages(e.target.value)} />
              <label htmlFor="chat-retrieval-query">検索の補助語</label><input id="chat-retrieval-query" disabled={waiting} className="border rounded bg-background px-2 py-1" placeholder="例：stability / 実験条件" value={retrievalQuery} onChange={e => setRetrievalQuery(e.target.value)} />
              <label htmlFor="chat-max-pages">検索するページ数</label><select id="chat-max-pages" disabled={waiting} className="border rounded bg-background px-2 py-1" value={maxPages} onChange={e => setMaxPages(Number(e.target.value))}><option value={10}>10ページ</option><option value={20}>20ページ</option><option value={30}>30ページ</option></select>
            </div>
            <p className="mt-1">条件を変えて再度質問すると、参照範囲を追加して回答を作成します。</p>
          </details>
        </div>
      </div>
    </div>
  );
}
