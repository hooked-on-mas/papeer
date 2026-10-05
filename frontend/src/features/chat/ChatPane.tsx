import React, { useEffect, useRef, useState } from "react";
import { FileText, Globe, Loader2, MessageSquare, Send, Square, X } from "lucide-react";
import { create } from "zustand";
import { useStore, type PassageAttachment, type PassageLocation } from "@/store";
import { paperBusyFor, runningPaperJob } from "@/features/jobs/jobSelectors";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { UsageLine } from "@/components/UsageLine";
import { useCollections, useMessages, usePaperList } from "@/api/hooks";
import { requestCancel, startJob } from "@/features/jobs/jobEvents";
import { showError } from "@/components/errorDialog";
import { showPassage } from "@/features/reader/navigation";
import { CitationEvidence } from "./CitationEvidence";
import { isImeKey } from "@/lib/imeKeys";
import { useResearch, useWebSearchCapability } from "@/features/references/researchHooks";
import { ResearchCard } from "@/features/references/ResearchDetails";
import { shell } from "@/shell";

const EXAMPLE_QUESTIONS = [
  "従来手法と比べた改善点は？",
  "手法の前提条件と、実験の条件は？",
  "限界と今後の課題は？",
];

type ChatOptions = {
  /** The paper the page options were set for; they are cleared for another paper. */
  paperId: string | null;
  scope: "paper" | "selected" | "collection";
  selectedIds: string[];
  collection: string;
  referencePages: string;
  retrievalQuery: string;
  maxPages: number;
};

// Outside the pane, which unmounts when its tab is left: attaching a passage from the reader
// must not quietly put the next question back on this paper alone.
const useChatOptions = create<ChatOptions>(() => ({
  paperId: null, scope: "paper", selectedIds: [], collection: "", referencePages: "", retrievalQuery: "", maxPages: 10,
}));

/** Sent when passages are attached but nothing is typed. */
const EXPLAIN_ATTACHED = "添付した箇所をわかりやすく説明してください。";
const EMPTY_KEYS: string[] = [];

/** A passage attached to a message: its page and first words; opens the PDF there, selected. */
function AttachmentChip({ passage, paperId, onRemove }: {
  passage: PassageLocation;
  paperId: string;
  onRemove?: () => void;
}) {
  const side = passage.side === "translated" ? "訳" : "";
  return (
    <span className="inline-flex max-w-full items-center rounded-md border bg-background text-[0.75rem] text-muted-foreground">
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
  // The same object until its own progress event, so that other jobs' events don't render the chat.
  const askJob = useStore((state) => runningPaperJob(state.activeJobs, state.activePaperId, ["ask"]));
  const busy = useStore((state) => paperBusyFor(state.activeJobs, state.activePaperId, "ask"));
  const { data: messages = [] } = useMessages(activePaperId);
  // Kept in the store: attaching passages means leaving this tab for the reader and coming back.
  const input = useStore((state) => (activePaperId && state.chatInputs[activePaperId]) || "");
  const setInput = (text: string) => { if (activePaperId) useStore.getState().setChatInput(activePaperId, text); };
  const allAttachments = useStore((state) => state.chatAttachments);
  const attachments = allAttachments.filter((item) => item.paperId === activePaperId);
  const { data: capability } = useWebSearchCapability();
  const webWanted = useStore(s => !!activePaperId && s.chatWebSearch[activePaperId] === true);
  const webSearch = webWanted && capability?.web_search === true;
  const researchKeys = useStore(s => (activePaperId && s.chatResearchKeys[activePaperId]) || EMPTY_KEYS);
  const { data: researchRecords = [] } = useResearch(activePaperId);
  const { scope, selectedIds, collection, referencePages, retrievalQuery, maxPages } = useChatOptions();
  const setScope = (value: ChatOptions["scope"]) => useChatOptions.setState({ scope: value });
  const setSelectedIds = (change: (ids: string[]) => string[]) => useChatOptions.setState((s) => ({ selectedIds: change(s.selectedIds) }));
  const setCollection = (value: string) => useChatOptions.setState({ collection: value });
  const setReferencePages = (value: string) => useChatOptions.setState({ referencePages: value });
  const setRetrievalQuery = (value: string) => useChatOptions.setState({ retrievalQuery: value });
  const setMaxPages = (value: number) => useChatOptions.setState({ maxPages: value });
  const { data: papers = [] } = usePaperList("", 0);
  const { data: collections = [] } = useCollections();
  const [pending, setPending] = useState<{ question: string; attachments: PassageLocation[]; webSearch: boolean } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Only on a real paper switch: a StrictMode rerun on mount would drop a message from the reader.
  const shownPaperId = useRef(activePaperId);
  useEffect(() => {
    if (shownPaperId.current !== activePaperId) {
      shownPaperId.current = activePaperId;
      setPending(null);
    }
    // Also after the pane was closed during the switch.
    if (useChatOptions.getState().paperId !== activePaperId) {
      useChatOptions.setState({ paperId: activePaperId, referencePages: "", retrievalQuery: "" });
    }
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

  const scopeReady = scope !== "selected" || selectedIds.length > 0;
  const send = async (text: string, attached: PassageAttachment[] = attachments) => {
    const question = text.trim() || (attached.length ? EXPLAIN_ATTACHED : "");
    if (!question || !activePaperId || busy || !scopeReady || (webWanted && capability === undefined)) return;
    const paperId = activePaperId;
    const passages = attached.map(toLocation);
    setPending({ question, attachments: passages, webSearch });
    try {
      await startJob(`/api/papers/${paperId}/ask`,
        { question, attachments: passages, scope, paper_ids: selectedIds, collection,
          reference_pages: referencePages, retrieval_query: retrievalQuery, max_pages: maxPages,
          web_search: webSearch, research_keys: researchKeys },
        { kind: "ask", paperId },
        (event) => {
          if (useStore.getState().activePaperId === paperId) setPending(null);
          // Keep the message and its passages for another try unless it was answered.
          // The input is kept per paper, so it is cleared even after switching to another.
          if (event.status !== "succeeded") return;
          const store = useStore.getState();
          if ((store.chatInputs[paperId] ?? "").trim() === text.trim()) store.setChatInput(paperId, "");
          store.removeChatAttachments(attached.map((item) => item.id));
          useStore.setState(s => ({ chatResearchKeys: { ...s.chatResearchKeys,
            [paperId]: (s.chatResearchKeys[paperId] ?? []).filter(key => !researchKeys.includes(key)) } }));
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
    if (draft.researchKeys) useStore.setState(s => ({ chatResearchKeys: { ...s.chatResearchKeys, [draft.paperId]: draft.researchKeys! } }));
    if (draft.paperIds?.length) useChatOptions.setState({ scope: "selected", selectedIds: draft.paperIds });
    if (draft.send && !busy && !askJob && pending === null && scopeReady) {
      send(draft.text, draft.attachments ?? []);
      return;
    }
    // Busy with another answer, or no paper chosen yet: leave it in the input to send later.
    draft.attachments?.forEach(store.addChatAttachment);
    setInput(draft.text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs for a new draft only; busy, send... are read as they are when it arrives
  }, [chatDraft, activePaperId]);

  const handleKeyDown =(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !isImeKey(e.nativeEvent)) {
      e.preventDefault();
      send(input);
    }
  };

  if (!activePaperId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 h-full">
        <p className="text-[0.9375rem] font-medium mb-1 text-foreground">論文が選択されていません</p>
        <p className="text-[0.8125rem]">左のライブラリから論文を選ぶか、PDF を追加してください</p>
      </div>
    );
  }

  const waiting = !!askJob || pending !== null;

  return (
    <div className="flex flex-col w-full h-full bg-background overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-3 space-y-4">
          {messages.length === 0 && !waiting && (
            <div className="flex flex-col items-center justify-center text-center py-6">
              <MessageSquare className="w-8 h-8 text-muted-foreground/30 mb-3" />
              <p className="text-[0.9375rem] font-medium mb-1">{webSearch ? "論文とWebの情報を使って、チャットする" : "本文を根拠に、チャットする"}</p>
              <p className="text-[0.8125rem] text-muted-foreground">手法の違い、実験条件、限界などを聞いてみてください。</p>
              <details className="mt-2 text-[0.75rem] text-muted-foreground">
                <summary className="cursor-pointer">PDFの箇所を添えるには</summary>
                <p className="mt-1">PDFで文章を選び、右クリックの「この箇所をチャットに添付」を選びます。</p>
              </details>
              <div className="flex flex-wrap justify-center gap-2 mt-3">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => { setInput(q); inputRef.current?.focus(); }}
                    className="text-[0.8125rem] px-3 py-1.5 border rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => msg.role === "user" ? (
            <div key={idx}>
              <div className="text-[0.75rem] font-medium text-muted-foreground mb-1">あなた{msg.research?.web_search && " · Web検索ON"}</div>
              <div className="rounded-lg bg-muted/60 border px-4 py-2.5 text-[0.875rem] space-y-2">
                <AttachmentList attachments={msg.attachments ?? []} paperId={activePaperId} />
                {!!msg.research?.attached_keys.length && <p className="text-xs text-muted-foreground">参考文献の調査結果を添付：{msg.research.records.filter(r => msg.research!.attached_keys.includes(r.key)).map(r => r.title).join("、")}</p>}
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>
            </div>
          ) : (
            <div key={idx}>
              <div className="text-[0.75rem] font-medium text-muted-foreground mb-1">回答 · {msg.research?.web_search ? "Web検索あり" : msg.research?.attached_keys.length ? "論文＋添付資料" : "論文のみ"}</div>
              <MarkdownRenderer content={msg.content} paperId={activePaperId} className="max-w-none" />
              <CitationEvidence content={msg.content} />
              {!!msg.research?.sources.length && <details className="mt-3 text-xs"><summary className="cursor-pointer">Webの出典 · {msg.research.sources.length}件</summary>
                <ul className="space-y-2 mt-2">{msg.research.sources.map((source, i) => <li key={`${source.url}:${i}`}><button className="text-primary hover:underline text-left break-all" onClick={() => void shell.openUrl(source.url).catch(e => showError(e, "出典を開けませんでした"))}>［Web {i + 1}］{source.title} ↗</button></li>)}</ul>
              </details>}
              {msg.research?.records.map(record => <ResearchCard key={record.key} sourcePaperId={activePaperId} record={record} />)}
              <UsageLine usage={msg.usage} className="mt-2" />
            </div>
          ))}

          {waiting && (
            <>
              {pending && (
                <div>
                  <div className="text-[0.75rem] font-medium text-muted-foreground mb-1">あなた{pending.webSearch && " · Web検索ON"}</div>
                  <div className="rounded-lg bg-muted/60 border px-4 py-2.5 text-[0.875rem] space-y-2">
                    <AttachmentList attachments={pending.attachments} paperId={activePaperId} />
                    <div className="whitespace-pre-wrap">{pending.question}</div>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-3 text-[0.8125rem] text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="truncate">{askJob?.message || "回答を作成中…"}</span>
                {askJob && (
                  <button
                    onClick={() => requestCancel(askJob.job_id).catch(() => undefined)}
                    className="flex items-center gap-1 px-2 py-1 rounded border text-[0.75rem] hover:bg-muted"
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
          {!!researchKeys.length && <div className="mb-2 flex flex-wrap gap-2">{researchKeys.map(key => <span key={key} className="inline-flex items-center gap-2 rounded border px-2 py-1 text-xs">
            参考文献：{researchRecords.find(r => r.key === key)?.title ?? "調査結果"}<button disabled={waiting} aria-label="参考文献の添付を外す" onClick={() => useStore.setState(s => ({ chatResearchKeys: { ...s.chatResearchKeys,
              [activePaperId]: researchKeys.filter(item => item !== key) } }))}><X className="size-3" /></button></span>)}</div>}
          {attachments.length > 0 && (
            <div className="mb-2">
              <AttachmentList attachments={attachments} paperId={activePaperId}
                onRemove={waiting ? undefined : (index) => useStore.getState().removeChatAttachments([attachments[index].id])} />
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              aria-label="論文への質問"
              className="flex-1 min-h-10 rounded-lg border border-input bg-background px-3 py-2.5 text-[0.8125rem] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none leading-relaxed disabled:opacity-60"
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
              className="flex items-center gap-1.5 justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 h-10 px-4 shrink-0 disabled:opacity-50 transition-opacity text-[0.8125rem] font-medium"
              onClick={() => send(input)}
              disabled={busy || waiting || (webWanted && capability === undefined) || (!input.trim() && !attachments.length) || (scope === "selected" && !selectedIds.length)}
            >
              <Send className="w-4 h-4" /> 送信
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 mt-1.5 text-[0.75rem] text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5">参照範囲
              <select disabled={waiting} className="border rounded bg-background px-1 disabled:opacity-60" value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
                <option value="paper">この論文</option><option value="selected">選んだ論文</option><option value="collection">フォルダー内</option>
              </select>
            </label>
            <button type="button" role="switch" aria-checked={webSearch} aria-label="Web検索" disabled={waiting || !capability?.web_search}
              title={capability === undefined ? "Web検索への対応を確認中です" : capability.web_search ? "論文に加えてWebの情報を参照します" : "この接続先はWeb検索に対応していません。設定のAI接続を変更してください。"}
              className={`inline-flex items-center gap-1.5 border rounded px-2 py-1 disabled:opacity-50 ${webSearch ? "bg-primary/10 text-primary border-primary/40" : "hover:bg-muted"}`}
              onClick={() => useStore.setState(s => ({ chatWebSearch: { ...s.chatWebSearch, [activePaperId]: !webSearch } }))}>
              <Globe className="size-3.5" />Web検索 {capability === undefined ? "確認中" : !capability.web_search ? "非対応" : webSearch ? "ON" : "OFF"}
            </button>
            </div>
            <span>Enter: 送信 / Shift+Enter: 改行</span>
          </div>
          {(webSearch || researchKeys.length > 0 || (webWanted && capability && !capability.web_search)) && <p role="status" className="mt-1 text-xs text-muted-foreground">{!capability?.web_search ? "この接続先はWeb検索に対応していません。設定のAI接続を変更してください。" : webSearch
            ? "論文に加えてWebを検索し、出典付きで回答します。" : researchKeys.length
              ? "新たなWeb検索はせず、論文と添付した調査結果を参照します。" : "新たなWeb検索はせず、論文を根拠に回答します。"}</p>}
          {scope === "selected" && <p role="status" className="mt-2 text-xs text-muted-foreground">
            {selectedIds.length ? `${selectedIds.length}件の論文を参照します。`
              : "参照する論文を1件以上選ぶと送信できます。"}
          </p>}
          {scope === "selected" && <div className="mt-2 max-h-28 overflow-auto border rounded p-2 grid grid-cols-2 gap-1 text-xs">
            {papers.map(paper => <label key={paper.id} className="flex gap-1 items-center truncate"><input type="checkbox" disabled={waiting} checked={selectedIds.includes(paper.id)} onChange={e => setSelectedIds(ids => e.target.checked ? [...ids, paper.id] : ids.filter(id => id !== paper.id))} /><span className="truncate" title={paper.title}>{paper.title}</span></label>)}
          </div>}
          {scope === "collection" && <select disabled={waiting} aria-label="参照するフォルダー" className="mt-2 w-full border rounded bg-background px-2 py-1 text-xs disabled:opacity-60" value={collection} onChange={e => setCollection(e.target.value)}>
            <option value="">未分類</option>{collections.filter(Boolean).map(name => <option key={name} value={name}>{name}</option>)}
          </select>}
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">論文の参照ページ・検索条件</summary>
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
