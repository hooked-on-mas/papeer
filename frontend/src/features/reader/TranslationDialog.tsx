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
  const [scope, setScope] = useState<"all" | "current" | "custom">("all");
  const [customRange, setCustomRange] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [starting, setStarting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [draftJobId, setDraftJobId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftMessage, setDraftMessage] = useState("");
  const draftSession = useRef(0);
  useEffect(() => {
    draftSession.current++;
    setGenerating(false);
    setDraftMessage("");
    return () => { draftSession.current++; };
  }, [open, paperId]);
  const busy = starting || generating || saving;
  const [glossary, setGlossary] = useState<{ source: string; target: string }[]>([]);
  const [glossaryDirty, setGlossaryDirty] = useState(false);
  const [glossaryReviewed, setGlossaryReviewed] = useState(false);
  const [newSources, setNewSources] = useState<Set<string>>(new Set());
  const [glossarySearch, setGlossarySearch] = useState("");
  const [glossaryView, setGlossaryView] = useState<"all" | "new" | "existing">("all");
  const savedSnapshot = useRef<{ source: string; target: string }[]>([]);
  useEffect(() => {
    setGlossaryReviewed(false); setNewSources(new Set()); setGlossarySearch(""); setGlossaryView("all");
  }, [open, paperId]);

  const { data: settings } = useSettings();
  const { data: reading } = useReading(open ? paperId : null);
  const { data: savedGlossary } = useQuery({
    queryKey: [QK.glossary],
    queryFn: () => apiRequest<{ source: string; target: string }[]>("GET", "/api/glossary"),
    enabled: open,
  });
  useEffect(() => { if (open) { setGlossaryDirty(false); setGlossary(savedGlossary ?? []); } }, [open, paperId]);
  useEffect(() => { if (savedGlossary && !glossaryDirty) { setGlossary(savedGlossary); savedSnapshot.current = savedGlossary; } }, [savedGlossary, glossaryDirty, paperId]);
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

  const handleStart = async () => {
    if (!selection.pages?.length || busy || !savedGlossary) return;
    if (!glossaryReviewed) { await generateGlossary(); return; }
    const pages = scope === "all" ? "" : selection.pages.join(",");
    setStarting(true);
    try {
      if (glossaryDirty) await saveGlossary();
      await startJob(`/api/papers/${paperId}/translate`,
        { pages, model: model || undefined, effort: effort || undefined },
        { kind: "translate", paperId });
      onOpenChange(false);
    } catch (error) {
      showError(error, "翻訳を開始できませんでした");
    } finally {
      setStarting(false);
    }
  };

  const saveGlossary = async () => {
    const terms = glossary.filter(item => item.source.trim() || item.target.trim()).map(t => ({ source: t.source.trim(), target: t.target.trim() }));
    await apiRequest("PUT", "/api/glossary", { terms, expected_terms: savedSnapshot.current });
    savedSnapshot.current = terms;
    await queryClient.invalidateQueries({ queryKey: [QK.glossary] });
    await queryClient.invalidateQueries({ queryKey: [QK.effectiveGlossary] });
    setGlossaryDirty(false);
  };

  const generateGlossary = async () => {
    if (busy || !savedGlossary) return;
    const session = draftSession.current;
    setGenerating(true);
    setDraftJobId(null);
    setDraftMessage("");
    try {
      const jobId = await startJob(`/api/papers/${paperId}/glossary-draft`, {
        terms: glossary.filter(t => t.source.trim() || t.target.trim()),
        model: model || undefined, effort: effort || undefined,
      }, { kind: "glossary-draft", paperId }, event => {
        if (session !== draftSession.current) return;
        setGenerating(false);
        if (event.status !== "succeeded") return;
        setGlossaryReviewed(true);
        const terms = event.result.terms as { source: string; target: string }[];
        if (terms.length) {
          setGlossary(values => [...values, ...terms]);
          setNewSources(values => new Set([...values, ...terms.map(t => t.source)]));
          setGlossaryDirty(true);
          setGlossaryView("new"); setGlossarySearch("");
        }
        setDraftMessage(terms.length ? `訳語の判断が必要な未登録語を${terms.length}件抽出しました。確認・修正して共通辞書に追加し、翻訳を開始できます。` : "訳語の判断が必要な未登録語はありません。既存の共通辞書を使って翻訳できます。");
      });
      if (session === draftSession.current) setDraftJobId(jobId);
    } catch (error) {
      if (session !== draftSession.current) return;
      setGenerating(false);
      showError(error, "翻訳対応表を作成できませんでした");
    }
  };

  const connection = providerLabel(providers, provider);
  const shownEffort = effort || settings?.reasoning_effort || "";

  return (
    <Dialog open={open} onOpenChange={async next => {
      if (!next && busy) return;
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
            <label className="text-[13px]">モデル</label>
            <NativeSelect value={model} onChange={(e) => setModel(e.target.value)} disabled={loadingModels && !models.length}>
              <option value="">AI接続の設定と同じ</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </NativeSelect>
            {efforts.length > 0 && (
              <>
                <label className="text-[13px]">推論の強さ (effort)</label>
                <NativeSelect value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">AI接続の設定と同じ</option>
                  {efforts.filter((e) => e.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </NativeSelect>
              </>
            )}
          </div>
          <p className="text-[12px] text-muted-foreground whitespace-pre-line">
            {`${connection}：${effectiveModel || "既定モデル"} / effort: ${shownEffort || "既定値"}\n`
              + "今回の翻訳と対応表の作成に適用します。接続先・解説・チャットの設定は変更しません。"}
          </p>
          <p className="text-[12px] text-muted-foreground whitespace-pre-line leading-relaxed">
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
            <p className={`text-[12px] ${selection.error ? "text-destructive" : "text-muted-foreground"}`}>
              {selection.error ?? (selection.pages ? `翻訳対象: ${selection.pages.length}ページ` : "")}
            </p>
          </div>
          <details className="border rounded p-2 text-[12px]">
            <summary className="cursor-pointer font-medium">全論文共通の専門用語辞書（{glossary.length}件）</summary>
            <p className="text-muted-foreground my-2">翻訳前に、AIがこの論文から共通辞書にない専門用語のうち、訳語が定まっていない語や訳し方に迷う語だけを日本語訳の案と一緒に抽出します。「モデル予測制御」のように訳語が一つに決まる語は候補に含めません。候補を確認・修正して追加すると、今後のすべての論文で使えます。過去の登録語もここで確認・修正できます。辞書の変更は各論文を次に翻訳するときに反映されます。</p>
            <fieldset disabled={busy} className="min-w-0">
            <Button onClick={generateGlossary} disabled={!savedGlossary || !settings}>
              {generating ? "AIが対応表を作成中…" : "AIで未登録の専門用語を確認"}
            </Button>
            <p role="status" className="text-muted-foreground my-2">{draftMessage || (glossary.length ? "過去の登録語を含む共通辞書です。今回の追加候補には「新規」と表示します。" : "上で選択したモデルを使用します。生成した対応表は保存するまで翻訳に適用されません。")}</p>
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
            {generating && draftJobId && <Button variant="outline" className="mt-2" onClick={() => {
              apiRequest("POST", `/api/jobs/${draftJobId}/cancel`).catch(error => showError(error, "作成を中止できませんでした"));
            }}>対応表の作成を中止</Button>}
          </details>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={async () => {
            if (glossaryDirty && !await askConfirm("辞書の変更を破棄", "保存していない辞書の変更を破棄しますか？", "破棄")) return;
            onOpenChange(false);
          }}>キャンセル</Button>
          <Button onClick={handleStart} disabled={!selection.pages?.length || busy || !savedGlossary}>{glossaryReviewed ? "辞書を適用して翻訳を開始" : "未登録語を確認して翻訳へ"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
