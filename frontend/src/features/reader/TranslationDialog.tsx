import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { api, unwrap } from "@/api/client";
import { fetchPaperDomains, useSavePaperDomains } from "@/api/mutations";
import { providerLabel, useProviderEfforts, useProviderModels, useProviders, useReading, useSettings, type ReadingData } from "@/api/hooks";
import { requestCancel, startJob } from "@/features/jobs/jobEvents";
import { jobCount, runningPaperJob } from "@/features/jobs/jobSelectors";
import { useStore } from "@/store";
import { showError } from "@/components/errorDialog";
import { askConfirm } from "@/components/AppDialogs";
import { QK } from "@/lib/queryKeys";
import { useOpenEdit } from "@/lib/pendingSaves";
import { parsePageSelection } from "@/lib/pageSelection";
import { useSessionState } from "@/lib/useSessionState";
import { GlossaryEditor, useGlossaryEditor } from "./GlossaryEditor";
import {
  countDomainTerms, nextAutoStart, domainFailureMessage, domainJobMessage, readSplitChecked, recordSplitChecked, selectionOf,
  splitCheckedCounts, splitDoneMessage, unchosenNewDomains, unchosenNewDomainsMessage, type DomainJob, type PaperDomains,
} from "./glossaryDomains";
import { startDomainSelect, startGlossarySplit } from "./glossaryJobs";
import { setGlossaryDialogPaper, startGlossaryDraft, takeGlossaryDraft, useGlossaryDrafts } from "./glossaryDraft";
import { markRebuildJob } from "./rebuildJobs";
import {
  draftResultMessage, effectiveTerms, glossaryKey, glossaryReviewSkip, isResuming, mergeDraftTerms, normalizeTerms, primaryDomain,
  readReviewedGlossary, recordReviewedGlossary, retranslatedInkPages, retranslationWarning, reviewSkipMessage, startButtonLabel, translationTargetText,
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
}

type Scope = "all" | "current" | "custom";

/** What the dialog asks for this time, from its opening on (useSessionState). */
type Choices = {
  /** The pages to translate; null until chosen, or until the paper's previous request is known. */
  request: { scope: Scope; customRange: string } | null;
  /** "" for the connection's settings. */
  model: string;
  effort: string;
  /** The terms were checked in this dialog: starting applies the candidates and records the check. */
  reviewed: boolean;
  /** glossaryKey of the glossary this paper was last translated with after a check (translationStart.ts). */
  reviewedKey: string | null;
  draftMessage: string;
  /** How the AI's work on the domain dictionaries ended, when the dialog has something to tell about it. */
  domainNote: string;
};

/** Reopen with the previous request, as the old dialog did: its pages, unless they were all of them. */
function previousRequest(reading: ReadingData, pageCount: number): { scope: Scope; customRange: string } {
  const previous = reading.preview?.target_pages;
  return previous?.length && previous.length !== pageCount ? { scope: "custom", customRange: previous.join(", ") } : { scope: "all", customRange: "" };
}

export function TranslationDialog({ open, onOpenChange, paperId, currentPage }: TranslationDialogProps) {
  useOpenEdit(open, "翻訳の設定・辞書");
  const session = open ? paperId : null;
  const [choices, choose] = useSessionState<Choices>(session, () => ({
    request: null, model: "", effort: "", reviewed: false, draftMessage: "", domainNote: "",
    reviewedKey: readReviewedGlossary(() => globalThis.localStorage, paperId),
  }));
  const { model, effort } = choices;
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
  // Any job of the paper still running (a translation, a check that went on through a reload): the sidecar
  // would refuse another with 409.
  const paperJobRunning = useStore((s) => !!runningPaperJob(s.activeJobs, paperId));
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
  const savedGlossary = glossary.saved;
  // The domain dictionaries this paper uses; the sidecar keeps the choice (the AI's, or the user's).
  const { data: domainRecord, isPending: loadingDomains, isFetching: fetchingDomains } = useQuery({
    queryKey: [QK.glossaryDomains, paperId], queryFn: () => fetchPaperDomains(paperId), enabled: open, retry: false,
  });
  const saveDomains = useSavePaperDomains();
  const queryClient = useQueryClient();
  const domainSelection = selectionOf(domainRecord);
  const busy = holding || generating || paperJobRunning || !!launching || (open && loadingDomains);
  // Show a finished check here, also one that finished while the dialog was closed. The list is this
  // opening's already (started over during the render): without unsaved edits, the saved glossary.
  useEffect(() => {
    // The main domain comes from the choice, which has to be read first: it cannot be put right afterwards.
    if (!open || !savedGlossary || loadingDomains || fetchingDomains || draft?.status !== "done") return;
    const terms = takeGlossaryDraft(paperId);
    if (!terms) return;
    // Only candidates the list does not have yet (the user may have added some meanwhile) count as new.
    const { glossary: merged, added } = mergeDraftTerms(glossary.terms, terms, primaryDomain(domainSelection));
    if (added.length) glossary.addCandidates(merged, added, { expand: true });
    choose({ reviewed: true, draftMessage: draftResultMessage(added.length) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- glossary and choose are new on every render; a finished check is what it waits for
  }, [open, paperId, draft, savedGlossary, loadingDomains, fetchingDomains]);
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
  const { data: plan, isFetching: planFetching } = useQuery({
    queryKey: [QK.translationPlan, paperId, pagesParam, model],
    queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/translation-plan", {
      params: { path: { paper_id: paperId }, query: { pages: pagesParam, ...(model ? { model } : {}) } } })) as TranslationPlan,
    enabled: open && !!selection.pages?.length,
    retry: false,
  });
  const { data: savedInkPages = [], refetch: refetchInkPages } = useQuery({
    queryKey: [QK.inkPages, paperId],
    queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/ink-pages", {
      params: { path: { paper_id: paperId } },
    })) as { side: InkSide; page: number; count: number }[],
    enabled: open,
  });
  useEffect(() => onAppEvent("ink-changed", (detail) => {
    if (detail.paperId === paperId && open) void refetchInkPages();
  }), [paperId, open, refetchInkPages]);
  const inkPages = new Map(savedInkPages.map((item) => [`${item.side}:${item.page}`, item]));
  for (const item of cachedInkPages(paperId)) inkPages.set(`${item.side}:${item.page}`, item);
  const affectedInkPages = retranslatedInkPages(planFetching ? undefined : plan, [...inkPages.values()]);
  // Only the terms this paper uses count: editing a dictionary it does not use is no reason to check again.
  const currentKey = glossaryKey(effectiveTerms(glossary.terms, domainSelection));
  // A plan being refetched (after a glossary save or a finished run) may be out of date.
  const skip = glossaryReviewSkip({
    plan: planFetching ? undefined : plan, glossaryDirty: glossary.dirty, resuming: isResuming(reading?.preview, selection.pages),
    reviewedKey: choices.reviewedKey, currentKey,
  });
  const warning = retranslationWarning(planFetching ? undefined : plan, !!domainRecord?.available.length);
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
  // What was started (by itself or by hand): the size a dictionary had when its split started, and the choices, so that
  // a job that failed is not started again in a loop, nor one whose result is not read yet. The choices are tried again
  // when the dialog is next opened.
  const started = useRef<{ splits: Record<string, number>; selects: Set<string> }>({ splits: {}, selects: new Set() });
  const runSplit = async (domain: string) => {
    const before = countDomainTerms(savedGlossary ?? [])[domain] ?? 0;
    started.current.splits[domain] = before;
    setLaunching("split");
    choose({ domainNote: "" });
    try {
      await startGlossarySplit(paperId, { domain, model: model || undefined, effort: effort || undefined }, (event) => {
        if (event.status === "failed") choose({ domainNote: domainFailureMessage("split", event.error) });
        else if (event.status === "succeeded") {
          // The same dictionary of the same size is not sent to the AI again by itself.
          recordSplitChecked(() => globalThis.localStorage, splitCheckedCounts(event.result, domain, before));
          choose({ domainNote: splitDoneMessage(event.result.moved) });
        }
      });
    } catch (error) {
      choose({ domainNote: domainFailureMessage("split", (error as Error).message) });
    } finally {
      setLaunching(null);
    }
  };
  useEffect(() => {
    if (!open) {
      started.current.selects.clear();
      return;
    }
    if (!domainRecord || !savedGlossary || !settings) return;
    const next = nextAutoStart({
      availableDomains: domainRecord.available, domainCounts: countDomainTerms(savedGlossary), record: domainRecord, dirty: glossary.dirty,
      // A dictionary or a choice being read again may be what a job has just changed: the cached one is not to go by.
      running: paperJobRunning || generating || !!launching || starting || saving || glossary.fetching || fetchingDomains,
      splitChecked: readSplitChecked(() => globalThis.localStorage), splitAt: domainRecord.split_at,
      paperId, tried: started.current,
    });
    if (next?.kind === "split") void runSplit(next.domain);
    else if (next?.kind === "select") {
      started.current.selects.add(next.key);
      void runSelect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSelect and runSplit are new on every render; what they wait for is listed
  }, [open, paperId, domainRecord, savedGlossary, settings, glossary.dirty, glossary.fetching, fetchingDomains, paperJobRunning, generating, launching, starting, saving]);

  const handleStart = async () => {
    if (!selection.pages?.length || busy || !savedGlossary) return;
    const pages = scope === "all" ? "" : selection.pages.join(",");
    // Every page from saved translations: the run only makes the PDF again (said so while it runs).
    const rebuild = skip === "reusable";
    setStarting(true);
    try {
      if (glossary.dirty) await glossary.save();
      const jobId = await startJob(`/api/papers/${paperId}/translate`,
        { pages, model: model || undefined, effort: effort || undefined },
        { kind: "translate", paperId });
      if (rebuild) markRebuildJob(jobId);
      // The next start skips the check while the glossary stays as it is now.
      if (choices.reviewed) recordReviewedGlossary(() => globalThis.localStorage, paperId, currentKey);
      onOpenChange(false);
    } catch (error) {
      showError(error, "翻訳を開始できませんでした");
    } finally {
      setStarting(false);
    }
  };

  const generateGlossary = async () => {
    if (busy || !savedGlossary) return;
    choose({ draftMessage: "" });
    try {
      await startGlossaryDraft(paperId, {
        terms: normalizeTerms(glossary.terms),
        model: model || undefined, effort: effort || undefined,
      });
    } catch (error) {
      showError(error, "翻訳対応表を作成できませんでした");
    }
  };

  const connection = providerLabel(providers, provider);
  const shownEffort = effort || settings?.reasoning_effort || "";

  return (
    <Dialog open={open} onOpenChange={async next => {
      if (!next && holding) return;
      if (!next && glossary.dirty && !await askConfirm("辞書の変更を破棄", "保存していない辞書の変更を破棄しますか？", "破棄")) return;
      onOpenChange(next);
    }}>
      <DialogContent className="sm:max-w-xl max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>翻訳の設定</DialogTitle>
          <DialogDescription>今回の翻訳に使うモデルと推論の強さ (effort)</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2">
            <label className="text-[0.8125rem]">モデル</label>
            <NativeSelect value={model} onChange={(e) => choose({ model: e.target.value, effort: "" })} disabled={loadingModels && !models.length}>
              <option value="">AI接続の設定と同じ</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </NativeSelect>
            {efforts.length > 0 && (
              <>
                <label className="text-[0.8125rem]">推論の強さ (effort)</label>
                <NativeSelect value={effort} onChange={(e) => choose({ effort: e.target.value })}>
                  <option value="">AI接続の設定と同じ</option>
                  {efforts.filter((e) => e.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </NativeSelect>
              </>
            )}
          </div>
          <p className="text-[0.75rem] text-muted-foreground whitespace-pre-line">
            {`${connection}：${effectiveModel || "既定モデル"} / effort: ${shownEffort || "既定値"}\n`
              + "今回の翻訳と対応表の作成に適用します。接続先・解説・チャットの設定は変更しません。"}
          </p>
          <p className="text-[0.75rem] text-muted-foreground whitespace-pre-line leading-relaxed">
            {`全${pageCount}ページ。PDFの先頭を1ページとして指定します。\n`
              + "文が前後のページへ続く場合は、つながるページも翻訳対象に含めます。\n"
              + "同じモデルでは保存済みの訳文を再利用します（effortの変更は次のAI処理から適用）。\n"
              + "モデルを変更すると指定ページを再翻訳します。指定外のページは以前の訳文のまま残ります。"}
          </p>
          <div className="grid gap-2">
            <NativeSelect value={scope} onChange={(e) => setRequest({ scope: e.target.value as Scope })}>
              <option value="all">全ページ</option>
              <option value="current">現在のページ（{Math.min(currentPage, pageCount || currentPage)}ページ）</option>
              <option value="custom">ページを指定</option>
            </NativeSelect>
            <Input
              value={customRange}
              onChange={(e) => setRequest({ customRange: e.target.value })}
              placeholder="例: 1, 3-5, 8"
              disabled={scope !== "custom"}
              onKeyDown={(e) => { if (e.key === "Enter" && !isImeKey(e.nativeEvent)) handleStart(); }}
            />
            <p className={`text-[0.75rem] ${selection.error ? "text-destructive" : "text-muted-foreground"}`}>
              {selection.error ?? (selection.pages ? translationTargetText(selection.pages.length, planFetching ? undefined : plan) : "")}
            </p>
          </div>
          <GlossaryEditor editor={glossary} transferKey={`${paperId}-${open}`} busy={busy} generating={generating}
            canGenerate={!!savedGlossary && !!settings} onGenerate={() => void generateGlossary()} onPending={setSaving}
            domains={{
              record: domainRecord, canSplit: !!savedGlossary && !!settings, onSplit: (domain) => void runSplit(domain),
              onChoose: async (domains, newDomain) => {
                // The boxes follow the click; the saved choice is read again when the save ends. A read still under way
                // (after a job) would put the previous choice back.
                const key = [QK.glossaryDomains, paperId];
                await queryClient.cancelQueries({ queryKey: key });
                queryClient.setQueryData<PaperDomains>(key, (old) => old && { ...old, domains, new_domain: newDomain, chosen_by: "user" });
                saveDomains.mutate({ paperId, domains, newDomain }, { onError: (error) => {
                  void queryClient.invalidateQueries({ queryKey: key });
                  showError(error, "分野辞書の選択を保存できませんでした");
                } });
              },
            }} />
          <div role="status" className="grid gap-1 text-[0.75rem]">
            {generating ? <div className="flex items-center gap-2">
              <p className="text-muted-foreground flex-1">
                {`AIが未登録の専門用語を抽出しています${draftCount ? `（${draftCount}）` : ""}。閉じても抽出は続き、終わったらお知らせします。`}</p>
              {cancelDraftId && <Button variant="outline" onClick={() => {
                requestCancel(cancelDraftId).catch(error => showError(error, "抽出を中止できませんでした"));
              }}>抽出を中止</Button>}
            </div> : <p className="text-muted-foreground">{choices.reviewed ? choices.draftMessage : reviewSkipMessage(skip)}</p>}
            {domainJob && <p className="text-muted-foreground">{domainJobMessage(domainJob)}</p>}
            {!domainJob && choices.domainNote && <p className="text-muted-foreground">{choices.domainNote}</p>}
            {unchosenMessage && <p className="text-amber-700 dark:text-amber-400">{unchosenMessage}</p>}
            {warning && <p className="text-amber-700 dark:text-amber-400">{warning}</p>}
            {affectedInkPages.length > 0 && <p className="text-amber-700 dark:text-amber-400">
              注意：再翻訳の対象となる日本語訳のうち、{affectedInkPages.length}ページに書き込みがあります。訳文や文章の配置が変わっても書き込みは元の位置に残るため、線や蛍光ペンが意図した箇所からずれる可能性があります。
            </p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={holding} onClick={async () => {
            if (glossary.dirty && !await askConfirm("辞書の変更を破棄", "保存していない辞書の変更を破棄しますか？", "破棄")) return;
            onOpenChange(false);
          }}>{generating ? "閉じる" : "キャンセル"}</Button>
          {!choices.reviewed && !skip && <Button variant="outline" onClick={generateGlossary}
            disabled={!selection.pages?.length || busy || !savedGlossary || !settings}>
            {generating ? "用語を抽出中…" : "用語を確認してから翻訳"}
          </Button>}
          <Button onClick={handleStart} disabled={!selection.pages?.length || busy || !savedGlossary}>
            {startButtonLabel({ reviewed: choices.reviewed, skip })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
