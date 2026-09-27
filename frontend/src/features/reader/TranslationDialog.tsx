import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { apiRequest } from "@/api/client";
import { providerLabel, useProviderEfforts, useProviderModels, useProviders, useReading, useSettings } from "@/api/hooks";
import { startJob } from "@/features/jobs/jobEvents";
import { showError } from "@/components/errorDialog";
import { askConfirm } from "@/components/AppDialogs";
import { GlossaryTransfer } from "./GlossaryTransfer";
import { QK } from "@/lib/queryKeys";
import { useOpenEdit } from "@/lib/pendingSaves";
import { setGlossaryDialogPaper, startGlossaryDraft, takeGlossaryDraft, useGlossaryDrafts } from "./glossaryDraft";
import {
  draftResultMessage, glossaryKey, glossaryReviewSkip, isResuming, mergeDraftTerms, normalizeTerms, readReviewedGlossary,
  recordReviewedGlossary, retranslationWarning, reviewSkipMessage, startButtonLabel, translationTargetText, type Term,
  type TranslationPlan,
} from "./translationStart";

interface TranslationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paperId: string;
  currentPage: number;
}

/** Same rules and messages as papeer.layout.page_selection, for feedback while typing. */
export function parsePageSelection(value: string, pageCount: number): number[] {
  const text = value.normalize("NFKC").replace(/、/g, ",").replace(/[～~–—−]/g, "-");
  if (!text.trim()) throw new Error("翻訳するページを入力してください。例: 1, 3-5, 8");
  const pages = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^\s*([0-9]+)\s*(?:-\s*([0-9]+)\s*)?$/.exec(part);
    if (!match) throw new Error("ページ番号と範囲をカンマで区切ってください。例: 1, 3-5, 8");
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (!(1 <= first && first <= last && last <= pageCount)) {
      throw new Error(`1～${pageCount}ページの範囲を、小さい番号から指定してください。`);
    }
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export function TranslationDialog({ open, onOpenChange, paperId, currentPage }: TranslationDialogProps) {
  const queryClient = useQueryClient();
  useOpenEdit(open, "翻訳の設定・辞書");
  const [scope, setScope] = useState<"all" | "current" | "custom">("all");
  const [customRange, setCustomRange] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftMessage, setDraftMessage] = useState("");
  // The AI's check for unregistered terms runs as a job that outlives the dialog (glossaryDraft).
  const draft = useGlossaryDrafts((s) => s.drafts[paperId]);
  const generating = draft?.status === "running";
  useEffect(() => {
    if (!open) return;
    setGlossaryDialogPaper(paperId);
    return () => setGlossaryDialogPaper(null);
  }, [open, paperId]);
  useEffect(() => { setDraftMessage(""); }, [open, paperId]);
  // Closing stays possible while the AI checks the terms; only saving and starting hold the dialog.
  const holding = starting || saving;
  const busy = holding || generating;
  const [glossary, setGlossary] = useState<Term[]>([]);
  const [glossaryDirty, setGlossaryDirty] = useState(false);
  // The terms were checked in this dialog: starting applies the candidates and records the check.
  const [glossaryReviewed, setGlossaryReviewed] = useState(false);
  const [reviewedKey, setReviewedKey] = useState<string | null>(null);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [newSources, setNewSources] = useState<Set<string>>(new Set());
  const [glossarySearch, setGlossarySearch] = useState("");
  const [glossaryView, setGlossaryView] = useState<"all" | "new" | "existing">("all");
  const savedSnapshot = useRef<Term[]>([]);
  useEffect(() => {
    setGlossaryReviewed(false); setNewSources(new Set()); setGlossarySearch(""); setGlossaryView("all");
    setGlossaryOpen(false);
    if (open) setReviewedKey(readReviewedGlossary(() => globalThis.localStorage, paperId));
  }, [open, paperId]);

  const { data: settings } = useSettings();
  const { data: reading } = useReading(open ? paperId : null);
  const { data: savedGlossary } = useQuery({
    queryKey: [QK.glossary],
    queryFn: () => apiRequest<Term[]>("GET", "/api/glossary"),
    enabled: open,
  });
  // The paper whose glossary list has been reset since the dialog opened: until then the list
  // may still hold the previous opening's edits.
  const [listReadyFor, setListReadyFor] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setGlossaryDirty(false); setGlossary(savedGlossary ?? []); }
    setListReadyFor(open ? paperId : null);
  }, [open, paperId]);
  useEffect(() => { if (savedGlossary && !glossaryDirty) { setGlossary(savedGlossary); savedSnapshot.current = savedGlossary; } }, [savedGlossary, glossaryDirty, paperId]);
  // Show a finished check here, also one that finished while the dialog was closed. After the
  // effect above: without unsaved edits the list is (being set to) the saved glossary.
  useEffect(() => {
    if (!open || listReadyFor !== paperId || !savedGlossary || draft?.status !== "done") return;
    const terms = takeGlossaryDraft(paperId);
    if (!terms) return;
    setGlossaryReviewed(true);
    // Only candidates the list does not have yet (the user may have added some meanwhile) count as new.
    const { glossary: merged, added } = mergeDraftTerms(glossaryDirty ? glossary : savedGlossary, terms);
    if (added.length) {
      setGlossary(merged);
      setNewSources(values => new Set([...values, ...added.map(t => t.source)]));
      setGlossaryDirty(true);
      setGlossaryView("new"); setGlossarySearch(""); setGlossaryOpen(true);
    }
    setDraftMessage(draftResultMessage(added.length));
  }, [open, paperId, listReadyFor, draft, savedGlossary]);
  const provider = settings?.provider ?? "";
  const pageCount = reading?.source_page_count ?? reading?.page_count ?? 0;

  // The saved connection settings (CLI path included) apply; only model and effort change here.
  const { data: providers } = useProviders();
  const { data: models = [], isFetching: loadingModels } = useProviderModels(provider, { enabled: open });
  const effectiveModel = model || settings?.model || "";
  const { data: efforts = [] } = useProviderEfforts(provider, effectiveModel, { enabled: open });

  useEffect(() => {
    if (!open) return;
    setModel("");
    setEffort("");
    // Reopen with the previous request, as the old dialog did.
    const previous = reading?.preview?.target_pages;
    if (previous?.length && previous.length !== pageCount) {
      setScope("custom");
      setCustomRange(previous.join(", "));
    } else {
      setScope("all");
      setCustomRange("");
    }
  }, [open, paperId, !!reading]);

  useEffect(() => setEffort(""), [model]);

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
    queryFn: () => apiRequest<TranslationPlan>("GET",
      `/api/papers/${paperId}/translation-plan?${new URLSearchParams({ pages: pagesParam, ...(model ? { model } : {}) })}`),
    enabled: open && !!selection.pages?.length,
    retry: false,
  });
  const currentKey = glossaryKey(glossaryDirty ? glossary : savedGlossary ?? []);
  // A plan being refetched (after a glossary save or a finished run) may be out of date.
  const skip = glossaryReviewSkip({
    plan: planFetching ? undefined : plan, glossaryDirty, resuming: isResuming(reading?.preview, selection.pages), reviewedKey, currentKey,
  });
  const warning = retranslationWarning(planFetching ? undefined : plan);

  const handleStart = async () => {
    if (!selection.pages?.length || busy || !savedGlossary) return;
    const pages = scope === "all" ? "" : selection.pages.join(",");
    setStarting(true);
    try {
      if (glossaryDirty) await saveGlossary();
      await startJob(`/api/papers/${paperId}/translate`,
        { pages, model: model || undefined, effort: effort || undefined },
        { kind: "translate", paperId });
      // The next start skips the check while the glossary stays as it is now.
      if (glossaryReviewed) recordReviewedGlossary(() => globalThis.localStorage, paperId, currentKey);
      onOpenChange(false);
    } catch (error) {
      showError(error, "翻訳を開始できませんでした");
    } finally {
      setStarting(false);
    }
  };

  const saveGlossary = async () => {
    const terms = normalizeTerms(glossary);
    await apiRequest("PUT", "/api/glossary", { terms, expected_terms: savedSnapshot.current });
    savedSnapshot.current = terms;
    await queryClient.invalidateQueries({ queryKey: [QK.glossary] });
    await queryClient.invalidateQueries({ queryKey: [QK.effectiveGlossary] });
    // A term changes the source of the pages that contain it, so their saved translations.
    await queryClient.invalidateQueries({ queryKey: [QK.translationPlan, paperId] });
    setGlossaryDirty(false);
  };

  const generateGlossary = async () => {
    if (busy || !savedGlossary) return;
    setDraftMessage("");
    try {
      await startGlossaryDraft(paperId, {
        terms: normalizeTerms(glossary),
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
      if (!next && glossaryDirty && !await askConfirm("辞書の変更を破棄", "保存していない辞書の変更を破棄しますか？", "破棄")) return;
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
            <NativeSelect value={model} onChange={(e) => setModel(e.target.value)} disabled={loadingModels && !models.length}>
              <option value="">AI接続の設定と同じ</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </NativeSelect>
            {efforts.length > 0 && (
              <>
                <label className="text-[0.8125rem]">推論の強さ (effort)</label>
                <NativeSelect value={effort} onChange={(e) => setEffort(e.target.value)}>
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
              + "モデルを変更すると指定ページを再翻訳し、指定外の訳文は引き継がれません。"}
          </p>
          <div className="grid gap-2">
            <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="all">全ページ</option>
              <option value="current">現在のページ（{Math.min(currentPage, pageCount || currentPage)}ページ）</option>
              <option value="custom">ページを指定</option>
            </NativeSelect>
            <Input
              value={customRange}
              onChange={(e) => setCustomRange(e.target.value)}
              placeholder="例: 1, 3-5, 8"
              disabled={scope !== "custom"}
              onKeyDown={(e) => { if (e.key === "Enter") handleStart(); }}
            />
            <p className={`text-[0.75rem] ${selection.error ? "text-destructive" : "text-muted-foreground"}`}>
              {selection.error ?? (selection.pages ? translationTargetText(selection.pages.length, planFetching ? undefined : plan) : "")}
            </p>
          </div>
          <details className="border rounded p-2 text-[0.75rem]" open={glossaryOpen} onToggle={e => setGlossaryOpen(e.currentTarget.open)}>
            <summary className="cursor-pointer font-medium">全論文共通の専門用語辞書（{glossary.length}件）</summary>
            <p className="text-muted-foreground my-2">用語を確認すると、翻訳前にAIがこの論文から共通辞書にない専門用語のうち、訳語が定まっていない語や訳し方に迷う語だけを日本語訳の案と一緒に抽出します。「モデル予測制御」のように訳語が一つに決まる語は候補に含めません。候補を確認・修正して追加すると、今後のすべての論文で使えます。過去の登録語もここで確認・修正できます。辞書の変更は各論文を次に翻訳するときに反映されます。</p>
            <fieldset disabled={busy} className="min-w-0">
            <Button onClick={generateGlossary} disabled={!savedGlossary || !settings}>
              {generating ? "AIが対応表を作成中…" : "AIで未登録の専門用語を確認"}
            </Button>
            <p className="text-muted-foreground my-2">{glossary.length ? "過去の登録語を含む共通辞書です。今回の追加候補には「新規」と表示します。" : "上で選択したモデルを使用します。生成した対応表は保存するまで翻訳に適用されません。"}</p>
            <div className="flex gap-1 my-2">
              <Button variant={glossaryView === "new" ? "default" : "outline"} onClick={() => setGlossaryView("new")}>今回の追加候補</Button>
              <Button variant={glossaryView === "existing" ? "default" : "outline"} onClick={() => setGlossaryView("existing")}>過去の登録語</Button>
              <Button variant={glossaryView === "all" ? "default" : "outline"} onClick={() => setGlossaryView("all")}>すべて</Button>
            </div>
            <Input aria-label="共通辞書を検索" placeholder="原語・日本語訳を検索" value={glossarySearch} onChange={e => setGlossarySearch(e.target.value)} className="mb-2" />
            <div className="grid grid-cols-[1fr_1fr_auto] gap-1 mb-1"><span>原語</span><span>日本語訳</span><span className="w-12" /></div>
            <div className="max-h-60 overflow-auto space-y-1">
              {glossary.map((item, index) => ({ item, index })).filter(({ item }) =>
                (glossaryView === "all" || newSources.has(item.source) === (glossaryView === "new")) &&
                `${item.source} ${item.target}`.toLocaleLowerCase().includes(glossarySearch.toLocaleLowerCase())).map(({ item, index }) => <div key={index} className="flex items-center gap-1">
                {newSources.has(item.source) && <span className="text-primary shrink-0">新規</span>}
                <Input aria-label={`原語 ${index + 1}`} placeholder="原語" value={item.source} onChange={e => { if (newSources.has(item.source)) setNewSources(values => { const next = new Set(values); next.delete(item.source); next.add(e.target.value); return next; }); setGlossary(values => values.map((v, i) => i === index ? { ...v, source: e.target.value } : v)); setGlossaryDirty(true); }} />
                <Input aria-label={`訳語 ${index + 1}`} placeholder="訳語" value={item.target} onChange={e => { setGlossary(values => values.map((v, i) => i === index ? { ...v, target: e.target.value } : v)); setGlossaryDirty(true); }} />
                <Button variant="outline" onClick={() => { setGlossary(values => values.filter((_, i) => i !== index)); setGlossaryDirty(true); }}>削除</Button>
              </div>)}
            </div>
            <div className="flex gap-2 mt-2">
              <Button variant="outline" onClick={() => { setGlossary(values => [...values, { source: "", target: "" }]); setGlossaryView("all"); setGlossarySearch(""); setNewSources(values => new Set([...values, ""])); setGlossaryDirty(true); }}>手動で用語を追加</Button>
              <Button variant="outline" disabled={!glossaryDirty || busy} onClick={async () => { setSaving(true); try { await saveGlossary(); } catch (error) { showError(error, "辞書を保存できませんでした"); } finally { setSaving(false); } }}>辞書を保存</Button>
            </div>
            </fieldset>
            <GlossaryTransfer key={`${paperId}-${open}`} terms={glossary} disabled={busy || !savedGlossary}
              onPending={setSaving} onImport={(terms, added) => {
                setGlossary(terms); setGlossaryDirty(true);
                setNewSources(values => new Set([...values, ...added.map(t => t.source)]));
                setGlossaryView("new"); setGlossarySearch("");
              }} />
          </details>
          <div role="status" className="grid gap-1 text-[0.75rem]">
            {generating ? <div className="flex items-center gap-2">
              <p className="text-muted-foreground flex-1">AIが未登録の専門用語を抽出しています。閉じても抽出は続き、終わったらお知らせします。</p>
              {draft.jobId && <Button variant="outline" onClick={() => {
                apiRequest("POST", `/api/jobs/${draft.jobId}/cancel`).catch(error => showError(error, "抽出を中止できませんでした"));
              }}>抽出を中止</Button>}
            </div> : <p className="text-muted-foreground">{glossaryReviewed ? draftMessage : reviewSkipMessage(skip)}</p>}
            {warning && <p className="text-amber-700 dark:text-amber-400">{warning}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={holding} onClick={async () => {
            if (glossaryDirty && !await askConfirm("辞書の変更を破棄", "保存していない辞書の変更を破棄しますか？", "破棄")) return;
            onOpenChange(false);
          }}>{generating ? "閉じる" : "キャンセル"}</Button>
          {!glossaryReviewed && !skip && <Button variant="outline" onClick={generateGlossary}
            disabled={!selection.pages?.length || busy || !savedGlossary || !settings}>
            {generating ? "用語を抽出中…" : "用語を確認してから翻訳"}
          </Button>}
          <Button onClick={handleStart} disabled={!selection.pages?.length || busy || !savedGlossary}>
            {startButtonLabel({ reviewed: glossaryReviewed, skip })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
