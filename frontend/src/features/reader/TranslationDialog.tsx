import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { api, unwrap } from "@/api/client";
import { fetchPaperDomains, useSavePaperDomains } from "@/api/mutations";
import { providerLabel, useProviderEfforts, useProviderModels, useProviders, useReading, useSettings, type ReadingData } from "@/api/hooks";
import { requestCancel, startJob } from "@/features/jobs/jobEvents";
import { jobCount, paperBusyFor, runningPaperJob } from "@/features/jobs/jobSelectors";
import { useStore } from "@/store";
import { showError } from "@/components/errorDialog";
import { askConfirm } from "@/components/AppDialogs";
import { QK } from "@/lib/queryKeys";
import { useOpenEdit } from "@/lib/pendingSaves";
import { parsePageSelection } from "@/lib/pageSelection";
import { useSessionState } from "@/lib/useSessionState";
import { DomainChoice, GlossaryEditor, useGlossaryEditor } from "./GlossaryEditor";
import { PaperGlossaryReview, usePaperGlossaryEditor } from "./PaperGlossaryReview";
import { TermFeedback } from "./TermFeedback";
import { withPaperTerms } from "./paperGlossary";
import {
  countDomainTerms, domainFailureMessage, domainJobMessage, selectionOf,
  unchosenNewDomains, unchosenNewDomainsMessage, type DomainJob, type PaperDomains,
} from "./glossaryDomains";
import { startDomainSelect, startGlossarySplit, takeSplitPreview, useGlossarySplitPreviews } from "./glossaryJobs";
import { setGlossaryDialogPaper, startGlossaryDraft, takeGlossaryDraft, useGlossaryDrafts } from "./glossaryDraft";
import { markRebuildJob } from "./rebuildJobs";
import {
  draftResultMessage, effectiveTerms, mergeDraftTerms, normalizeTerms, primaryDomain,
  retranslatedInkPages, retranslationWarning, startButtonLabel, translationTargetText,
  type TranslationPlan,
} from "./translationStart";
import { isImeKey } from "@/lib/imeKeys";
import { onAppEvent } from "@/lib/appEvents";
import { cachedInkPages, type InkSide } from "./inkStore";

interface TranslationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paperId: string;
  currentPage: number;
  initialTab?: "translation" | "terms" | "dictionary";
}

type Scope = "all" | "current" | "custom";

/** What the dialog asks for this time, from its opening on (useSessionState). */
type Choices = {
  tab: "translation" | "terms" | "dictionary";
  saveNote: string;
  /** The pages to translate; null until chosen, or until the paper's previous request is known. */
  request: { scope: Scope; customRange: string } | null;
  /** "" for the connection's settings. */
  model: string;
  effort: string;
  /** Candidate extraction finished while editing the optional terms. */
  reviewed: boolean;
  draftMessage: string;
  /** How the AI's work on the domain dictionaries ended, when the dialog has something to tell about it. */
  domainNote: string;
};

/** Reopen with the previous request, as the old dialog did: its pages, unless they were all of them. */
function previousRequest(reading: ReadingData, pageCount: number): { scope: Scope; customRange: string } {
  const previous = reading.preview?.target_pages;
  return previous?.length && previous.length !== pageCount ? { scope: "custom", customRange: previous.join(", ") } : { scope: "all", customRange: "" };
}

export function TranslationDialog({ open, onOpenChange, paperId, currentPage, initialTab = "translation" }: TranslationDialogProps) {
  useOpenEdit(open, "翻訳・訳語の設定");
  const session = open ? paperId : null;
  const [choices, choose] = useSessionState<Choices>(session, () => ({
    tab: initialTab, saveNote: "", request: null, model: "", effort: "", reviewed: false, draftMessage: "", domainNote: "",
  }));
  const { model, effort } = choices;
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; }, [choices.tab]);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  // The AI's check for unregistered terms runs as a job that outlives the dialog (glossaryDraft).
  const draft = useGlossaryDrafts((s) => s.drafts[paperId]);
  // Also a check this window did not start or has forgotten (it went on through a reload), from the job list.
  const draftJobId = useStore((s) => runningPaperJob(s.activeJobs, paperId, ["glossary-draft"])?.job_id);
  const generating = draft?.status === "running" || !!draftJobId;
  const cancelDraftId = (draft?.status === "running" ? draft.jobId : null) ?? draftJobId ?? null;
  // How far the check has got (「1/2」, a request per part of the paper), from its progress events.
  const draftCount = useStore((s) => generating ? jobCount(runningPaperJob(s.activeJobs, paperId, ["glossary-draft"])) : "");
  // Independent reference lookup can continue while translating or checking the paper's terms.
  const paperJobRunning = useStore((s) => paperBusyFor(s.activeJobs, paperId, "translate"));
  useEffect(() => {
    if (!open) return;
    setGlossaryDialogPaper(paperId);
    return () => setGlossaryDialogPaper(null);
  }, [open, paperId]);
  // The AI's choice of the domain dictionaries and its split of a dictionary are paper jobs too. `launching`: from
  // the request that starts one until it shows in the job list.
  const [launching, setLaunching] = useState<DomainJob | null>(null);
  const runningDomainJob = useStore((s): DomainJob | null =>
    runningPaperJob(s.activeJobs, paperId, ["glossary-select"]) ? "select" : runningPaperJob(s.activeJobs, paperId, ["glossary-split"]) ? "split" : null);
  const domainJob = launching ?? runningDomainJob;
  // Closing stays possible while the AI checks the terms; only saving and starting hold the dialog.
  const holding = starting || saving;

  const { data: settings } = useSettings();
  const { data: reading } = useReading(open ? paperId : null);
  const glossary = useGlossaryEditor(session);
  const localGlossary = usePaperGlossaryEditor(session, paperId);
  const savedGlossary = glossary.saved;
  const splitPreview = useGlossarySplitPreviews((s) => s.previews[paperId]);
  useEffect(() => {
    if (!open || choices.tab === "translation" || !savedGlossary || !splitPreview || glossary.dirty) return;
    const preview = takeSplitPreview(paperId);
    if (!preview) return;
    glossary.previewSplit(preview.terms, preview.original);
    choose({ tab: "dictionary", domainNote: `分割案で${preview.moved}語の分野を変更しました。確認して「辞書を保存」で適用できます。` });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a finished preview is consumed once, after the current glossary loads
  }, [open, choices.tab, savedGlossary, splitPreview, glossary.dirty, paperId]);
  // The domain dictionaries this paper uses; the sidecar keeps the choice (the AI's, or the user's).
  const { data: domainRecord, isPending: loadingDomains, isFetching: fetchingDomains } = useQuery({
    queryKey: [QK.glossaryDomains, paperId], queryFn: () => fetchPaperDomains(paperId), enabled: open, retry: false,
  });
  const saveDomains = useSavePaperDomains();
  const queryClient = useQueryClient();
  const domainSelection = selectionOf(domainRecord);
  const busy = holding || generating || paperJobRunning || !!launching || (open && loadingDomains)
    || localGlossary.fetching || saveDomains.isPending;
  // Show a finished check here, also one that finished while the dialog was closed. The list is this
  // opening's already (started over during the render): without unsaved edits, the saved glossary.
  useEffect(() => {
    // The main domain comes from the choice, which has to be read first: it cannot be put right afterwards.
    if (!open || choices.tab === "translation" || !savedGlossary || !localGlossary.saved || localGlossary.fetching || loadingDomains || fetchingDomains || draft?.status !== "done") return;
    const terms = takeGlossaryDraft(paperId);
    if (!terms) return;
    // Only candidates the list does not have yet (the user may have added some meanwhile) count as new.
    const count = localGlossary.addCandidates(terms);
    choose({ reviewed: true, draftMessage: draftResultMessage(count) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- glossary and choose are new on every render; a finished check is what it waits for
  }, [open, choices.tab, paperId, draft, savedGlossary, localGlossary.saved, localGlossary.fetching, loadingDomains, fetchingDomains]);
  const provider = settings?.provider ?? "";
  const pageCount = reading?.source_page_count ?? reading?.page_count ?? 0;
  // Once the paper is loaded; a choice made before that stays.
  if (open && reading && !choices.request) choose({ request: previousRequest(reading, pageCount) });
  const { scope, customRange } = choices.request ?? { scope: "all" as Scope, customRange: "" };
  const setRequest = (change: Partial<{ scope: Scope; customRange: string }>) =>
    choose((c) => ({ request: { ...(c.request ?? { scope, customRange }), ...change } }));

  // The saved connection settings (CLI path included) apply; only model and effort change here.
  const { data: providers } = useProviders();
  const { data: models = [], isFetching: loadingModels } = useProviderModels(provider, { enabled: open });
  const effectiveModel = model || settings?.model || "";
  const { data: efforts = [] } = useProviderEfforts(provider, effectiveModel, { enabled: open });

  const selection = useMemo((): { pages: number[] | null; error: string | null } => {
    if (!pageCount) return { pages: null, error: null };
    if (scope === "all") return { pages: Array.from({ length: pageCount }, (_, i) => i + 1), error: null };
    if (scope === "current") return { pages: [Math.min(currentPage, pageCount)], error: null };
    try {
      return { pages: parsePageSelection(customRange, pageCount), error: null };
    } catch (error) {
      return { pages: null, error: (error as Error).message };
    }
  }, [scope, customRange, currentPage, pageCount]);

  // What starting would do with these pages and this model: which pages come from saved
  // translations, and which translated pages the model would redo.
  const pagesParam = scope === "all" ? "" : (selection.pages?.join(",") ?? "");
  const { data: plan, isFetching: planFetching, isError: planError, refetch: refetchPlan } = useQuery({
    queryKey: [QK.translationPlan, paperId, pagesParam, model],
    queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/translation-plan", {
      params: { path: { paper_id: paperId }, query: { pages: pagesParam, ...(model ? { model } : {}) } } })) as TranslationPlan,
    enabled: open && !!selection.pages?.length,
    retry: false,
  });
  const { data: savedInkPages, isFetching: inkFetching, isError: inkError, refetch: refetchInkPages } = useQuery({
    queryKey: [QK.inkPages, paperId],
    queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/ink-pages", {
      params: { path: { paper_id: paperId } },
    })) as { side: InkSide; page: number; count: number }[],
    enabled: open,
  });
  useEffect(() => onAppEvent("ink-changed", (detail) => {
    if (detail.paperId === paperId && open) void refetchInkPages();
  }), [paperId, open, refetchInkPages]);
  const inkPages = new Map((savedInkPages ?? []).map((item) => [`${item.side}:${item.page}`, item]));
  for (const item of cachedInkPages(paperId)) inkPages.set(`${item.side}:${item.page}`, item);
  const affectedInkPages = retranslatedInkPages(planFetching ? undefined : plan, [...inkPages.values()]);
  const startReady = !!plan && !!savedInkPages && !!reading && !!settings && !planFetching && !inkFetching && !planError && !inkError;
  const startBusy = holding || paperJobRunning || !!domainJob || generating || saveDomains.isPending;
  const sharedTerms = effectiveTerms(glossary.terms, domainSelection);
  const warning = retranslationWarning(planFetching ? undefined : plan);
  const unchosenMessage = unchosenNewDomainsMessage(unchosenNewDomains(domainRecord));

  // The AI's work on the dictionaries. A failure is told in the dialog only (the handlers are quiet, translationJobs).
  const runSelect = async () => {
    setLaunching("select");
    choose({ domainNote: "" });
    try {
      await startDomainSelect(paperId, { model: model || undefined, effort: effort || undefined }, (event) => {
        if (event.status === "failed") choose({ domainNote: domainFailureMessage("select", event.error) });
      });
    } catch (error) {
      choose({ domainNote: domainFailureMessage("select", (error as Error).message) });
    } finally {
      setLaunching(null);
    }
  };
  const runSplit = async (domain: string) => {
    setLaunching("split");
    choose({ domainNote: "" });
    try {
      await startGlossarySplit(paperId, { domain, model: model || undefined, effort: effort || undefined, preview: true }, (event) => {
        if (event.status === "failed") choose({ domainNote: domainFailureMessage("split", event.error) });
        else if (event.status === "succeeded") {
          if (!event.result.moved) choose({ domainNote: "分野を分け直す必要がある語はありませんでした。" });
        }
      });
    } catch (error) {
      choose({ domainNote: domainFailureMessage("split", (error as Error).message) });
    } finally {
      setLaunching(null);
    }
  };
  const handleStart = async () => {
    if (!selection.pages?.length || startBusy || !startReady) return;
    if (glossary.dirty || localGlossary.dirty) {
      choose({ tab: glossary.dirty ? "dictionary" : "terms", saveNote: "訳語の変更を保存してから、翻訳に戻ってください。" });
      return;
    }
    const pages = scope === "all" ? "" : selection.pages.join(",");
    // Every page from saved translations: the run only makes the PDF again (said so while it runs).
    const rebuild = !plan.needs_ai;
    setStarting(true);
    try {
      const jobId = await startJob(`/api/papers/${paperId}/translate`,
        { pages, model: model || undefined, effort: effort || undefined },
        { kind: "translate", paperId });
      if (rebuild) markRebuildJob(jobId);
      onOpenChange(false);
    } catch (error) {
      showError(error, "翻訳を開始できませんでした");
    } finally {
      setStarting(false);
    }
  };

  const generateGlossary = async () => {
    if (busy || !savedGlossary || localGlossary.dirty || localGlossary.candidates.length > 0) return;
    choose({ draftMessage: "" });
    try {
      await startGlossaryDraft(paperId, {
        terms: normalizeTerms(withPaperTerms(effectiveTerms(glossary.terms, domainSelection), localGlossary.effective)),
        model: model || undefined, effort: effort || undefined,
      });
    } catch (error) {
      showError(error, "翻訳対応表を作成できませんでした");
    }
  };

  const saveTerms = async (shared: boolean) => {
    if (busy) return;
    setSaving(true);
    choose({ saveNote: "" });
    try {
      if (shared) await glossary.save();
      else await localGlossary.save();
      choose({ saveNote: shared ? "辞書を保存しました。各論文の次の翻訳から反映します。" : "この論文の訳語を保存しました。次の翻訳から反映します。" });
    } catch (error) {
      showError(error, "訳語を保存できませんでした");
    } finally {
      setSaving(false);
    }
  };

  const chooseDomains = async (domains: string[], newDomain: string | null) => {
    const key = [QK.glossaryDomains, paperId];
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData<PaperDomains>(key, (old) => old && { ...old, domains, new_domain: newDomain, chosen_by: "user", scope_terms: [], scope_stale: true });
    saveDomains.mutate({ paperId, domains, newDomain }, { onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: key });
      showError(error, "分野辞書の選択を保存できませんでした");
    } });
  };

  const connection = providerLabel(providers, provider);
  const shownEffort = effort || settings?.reasoning_effort || "";

  return (
    <Dialog open={open} onOpenChange={async next => {
      if (!next && holding) return;
      if (!next && (glossary.dirty || localGlossary.dirty) && !await askConfirm("訳語の変更を破棄", "保存していない訳語の変更を破棄しますか？", "破棄")) return;
      onOpenChange(next);
    }}>
      <DialogContent className={`${choices.tab === "dictionary" ? "sm:max-w-3xl" : choices.tab === "terms" ? "sm:max-w-xl" : "sm:max-w-lg"} max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden`}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{choices.tab === "translation" ? "日本語に翻訳" : choices.tab === "terms" ? "訳語の修正" : "共用辞書"}</DialogTitle>
          <DialogDescription>{choices.tab === "translation" ? "翻訳するページを選んで、開始してください。訳語は論文の文脈に合わせて自動で統一します。" : choices.tab === "terms" ? "読んでいて気になった訳語を、一括置換したり今後の翻訳に反映できます。" : "ほかの論文にも使う訳語を管理します。変更は各論文の次の翻訳に反映されます。"}</DialogDescription>
        </DialogHeader>
        <Tabs className="min-h-0 flex-1 flex-col gap-3 overflow-hidden" value={choices.tab} onValueChange={value => choose({ tab: value as Choices["tab"], saveNote: "" })}>
          <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
          <TabsContent value="translation" className="grid gap-4 py-1">
          <div className="grid gap-2">
            <label htmlFor="translation-pages" className="text-sm font-medium">翻訳するページ</label>
            <NativeSelect id="translation-pages" aria-label="翻訳するページ" value={scope} onChange={(e) => setRequest({ scope: e.target.value as Scope })}>
              <option value="all">全ページ</option>
              <option value="current">現在のページ（{Math.min(currentPage, pageCount || currentPage)}ページ）</option>
              <option value="custom">ページを指定</option>
            </NativeSelect>
            {scope === "custom" && <Input
              aria-label="翻訳するページ番号"
              value={customRange}
              onChange={(e) => setRequest({ customRange: e.target.value })}
              placeholder="例: 1, 3-5, 8"
              onKeyDown={(e) => { if (e.key === "Enter" && !isImeKey(e.nativeEvent)) handleStart(); }}
            />}
            <p className={`text-[0.75rem] ${selection.error ? "text-destructive" : "text-muted-foreground"}`}>
              {selection.error ?? (selection.pages ? translationTargetText(selection.pages.length, planFetching ? undefined : plan) : "")}
            </p>
          </div>
          <details className="border rounded p-2 text-[0.8125rem]">
          <summary className="cursor-pointer font-medium">詳細設定（モデル: {effectiveModel || "既定モデル"}）</summary>
          <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2 mt-2">
            <label className="text-[0.8125rem]">モデル</label>
            <NativeSelect aria-label="翻訳に使うモデル" value={model} onChange={(e) => choose({ model: e.target.value, effort: "" })} disabled={loadingModels && !models.length}>
              <option value="">AI接続の設定と同じ</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </NativeSelect>
            {efforts.length > 0 && (
              <>
                <label className="text-[0.8125rem]">推論の強さ (effort)</label>
                <NativeSelect aria-label="翻訳の推論の強さ" value={effort} onChange={(e) => choose({ effort: e.target.value })}>
                  <option value="">AI接続の設定と同じ</option>
                  {efforts.filter((e) => e.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </NativeSelect>
              </>
            )}
          </div>
          <p className="text-[0.75rem] text-muted-foreground whitespace-pre-line">
            {`${connection}：${effectiveModel || "既定モデル"} / effort: ${shownEffort || "既定値"}\n`
              + "今回の翻訳に使います。"}
          </p>
          <p className="text-[0.75rem] text-muted-foreground whitespace-pre-line leading-relaxed">
            {`全${pageCount}ページ。PDFの先頭を1ページとして指定します。\n`
              + "文が前後のページへ続く場合は、つながるページも翻訳対象に含めます。\n"
              + "同じモデルでは保存済みの訳文を再利用します（effortの変更は次のAI処理から適用）。\n"
              + "モデルを変更すると指定ページを再翻訳します。指定外のページは以前の訳文のまま残ります。"}
          </p>
          </details>
          <p className="text-xs text-muted-foreground">事前の訳語確認は不要です。気になる訳語は、読書中に「訳語の修正」から直せます。</p>
          <Button variant="ghost" className="justify-start text-muted-foreground" onClick={() => choose({ tab: "terms", saveNote: "" })}>訳語の修正</Button>
          </TabsContent>
          <TabsContent value="terms" className="grid gap-4 py-1">
          <TermFeedback key={paperId} paperId={paperId} />
          <details className="rounded-lg border p-3 text-[0.8125rem]">
          <summary className="cursor-pointer">訳語の一覧・辞書を管理（詳細設定）</summary>
          <div className="mt-3 space-y-3">
          <PaperGlossaryReview editor={localGlossary} sharedTerms={sharedTerms} busy={busy} dictionarySettings={domainRecord && <fieldset disabled={busy} className="min-w-0">
            <DomainChoice record={domainRecord} counts={countDomainTerms(savedGlossary ?? [])} onChoose={chooseDomains}>
              <details className="border-t pt-2 text-xs">
                <summary className="cursor-pointer text-muted-foreground">訳語の適用を確認・更新</summary>
                <div className="mt-2 space-y-2">
                  <Button variant="outline" disabled={!savedGlossary || !settings || glossary.dirty} onClick={() => void runSelect()}>AIで適用する訳語を選び直す</Button>
                  {domainJob && <p role="status" className="text-muted-foreground">{domainJobMessage(domainJob)}</p>}
                  {choices.domainNote && <p className="text-muted-foreground break-words">{choices.domainNote}</p>}
                  {unchosenMessage && <p className="text-amber-700 dark:text-amber-400">{unchosenMessage}</p>}
                </div>
              </details>
              <Button variant="ghost" className="justify-start text-muted-foreground" onClick={() => choose({ tab: "dictionary", saveNote: "" })}>共用辞書を管理{glossary.dirty ? "（未保存の変更あり）" : ""}</Button>
            </DomainChoice>
          </fieldset>} onShare={(term, originalDomain) => {
            const destination = originalDomain ?? primaryDomain(domainSelection);
            const { glossary: merged, added } = mergeDraftTerms(glossary.terms, [term], destination);
            if (added.length) {
              glossary.addCandidates(merged, added, { expand: true });
              choose({ tab: "dictionary", saveNote: `使う分野「${destination}」の追加候補に入れました。訳語と分野を確認して「辞書を保存」で反映します。` });
            } else {
              glossary.setView("all"); glossary.setSearch(term.source); glossary.setDomainFilter(destination);
              choose({ tab: "dictionary", saveNote: `「${term.source}」は分野「${destination}」に登録済みです。この論文の訳「${term.target}」と比較して、必要なら辞書の訳語を編集してください。` });
            }
          }} />
          <details className="rounded-lg border p-3 text-[0.8125rem]">
            <summary className="cursor-pointer font-medium">AIに訳語を提案してもらう（任意）</summary>
            <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[0.8125rem]">
            <p className="text-muted-foreground">AIが論文から専門用語を拾い、訳語候補を最大5件提案します。</p>
            <Button variant="outline" onClick={generateGlossary}
              title={localGlossary.dirty || localGlossary.candidates.length > 0 ? "先に「この論文の訳語を保存」で、編集中の訳語と候補を確定してください。" : "辞書にない専門用語の訳語候補を提案します。選んだ候補をこの論文だけに適用します。AIの利用枠を使います。"}
              disabled={busy || !savedGlossary || !settings || localGlossary.dirty || localGlossary.candidates.length > 0}>
              {generating ? "訳語候補を抽出中…" : "AIで訳語候補を抽出"}
            </Button>
          </div>
            <p className="text-xs text-muted-foreground">AIの利用枠を使います。</p>
            </div>
          </details>
          </div>
          </details>
          </TabsContent>
          <TabsContent value="dictionary" className="space-y-3 py-1">
          <Button variant="ghost" className="justify-start text-muted-foreground" onClick={() => choose({ tab: "terms", saveNote: "" })}>← この論文の訳語に戻る{localGlossary.dirty ? "（未保存の変更あり）" : ""}</Button>
          <GlossaryEditor editor={glossary} transferKey={`${paperId}-${open}`} busy={busy} onPending={setSaving}
            saveInFooter
            domains={{
              record: domainRecord, canSplit: !!savedGlossary && !!settings, onSplit: (domain) => void runSplit(domain),
              onRefresh: () => void runSelect(),
              onChoose: chooseDomains,
            }} />
          </TabsContent>
          <div role="status" className="grid gap-1 text-[0.75rem]">
            {choices.tab !== "translation" && choices.saveNote && <p className="text-primary">{choices.saveNote}</p>}
            {choices.tab !== "translation" && generating ? <div className="flex items-center gap-2">
              <p className="text-muted-foreground flex-1">
                {`AIが未登録の専門用語を抽出しています${draftCount ? `（${draftCount}）` : ""}。閉じても抽出は続き、終わったらお知らせします。`}</p>
              {cancelDraftId && <Button variant="outline" onClick={() => {
                requestCancel(cancelDraftId).catch(error => showError(error, "抽出を中止できませんでした"));
              }}>抽出を中止</Button>}
            </div> : choices.tab === "terms" && choices.reviewed && <p className="text-muted-foreground">{choices.draftMessage}</p>}
            {choices.tab === "dictionary" && domainJob && <p className="text-muted-foreground">{domainJobMessage(domainJob)}</p>}
            {choices.tab === "dictionary" && !domainJob && choices.domainNote && <p className="text-muted-foreground">{choices.domainNote}</p>}
            {choices.tab === "translation" && warning && <p className="text-amber-700 dark:text-amber-400">{warning}</p>}
            {choices.tab === "translation" && (planError || inkError) && <div className="flex items-center gap-2 text-destructive">
              <p>翻訳対象と書き込みを確認できませんでした。</p>
              <Button variant="outline" disabled={planFetching || inkFetching} onClick={() => {
                void refetchPlan(); void refetchInkPages();
              }}>再試行</Button>
            </div>}
            {choices.tab === "translation" && affectedInkPages.length > 0 && <p className="text-amber-700 dark:text-amber-400">
              注意：再翻訳の対象となる日本語訳のうち、{affectedInkPages.length}ページに書き込みがあります。訳文や文章の配置が変わっても書き込みは元の位置に残るため、線や蛍光ペンが意図した箇所からずれる可能性があります。
            </p>}
          </div>
        </div>
        </Tabs>
        <DialogFooter className="shrink-0">
          <Button variant="outline" disabled={holding} onClick={async () => {
            if ((glossary.dirty || localGlossary.dirty) && !await askConfirm("訳語の変更を破棄", "保存していない訳語の変更を破棄しますか？", "破棄")) return;
            onOpenChange(false);
          }}>{generating ? "閉じる" : "キャンセル"}</Button>
          {choices.tab !== "translation" && <Button variant="outline" disabled={holding} onClick={() => choose({ tab: "translation", saveNote: "" })}>翻訳に戻る</Button>}
          {choices.tab === "dictionary" ? <Button onClick={() => void saveTerms(true)} disabled={!glossary.dirty || busy || !savedGlossary}>辞書を保存</Button> : choices.tab === "terms" ? <Button disabled={busy || (!localGlossary.dirty && !localGlossary.candidates.length)} onClick={() => void saveTerms(false)}>この論文の訳語を保存</Button> : <>
          <Button onClick={handleStart} disabled={!selection.pages?.length || startBusy || !startReady}>
            {planFetching || inkFetching ? "翻訳対象を確認中…" : startButtonLabel({ reviewed: false, skip: plan?.needs_ai === false ? "reusable" : null })}
          </Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
