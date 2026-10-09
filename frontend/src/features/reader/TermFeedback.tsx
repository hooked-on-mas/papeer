import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { useProviders, useSettings } from "@/api/hooks";
import type { components } from "@/api/schema";
import type { TermResearchResult } from "@/api/jobTypes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { showError } from "@/components/errorDialog";
import { startJob } from "@/features/jobs/jobEvents";
import { paperBusy, useStore } from "@/store";
import { onAppEvent, type AppEvents } from "@/lib/appEvents";
import { shell } from "@/shell";
import { QK } from "@/lib/queryKeys";

type Card = components["schemas"]["TermCardEntry"];
type CardAnswer = components["schemas"]["TermCard"];
type Preview = { key: string; changes: { id: string; pages: number[]; source: string; text: string; after: string }[] };
type Asked = { source: string; before: string; target: string };

const PREVIEW_DELAY_MS = 500;

export function TermFeedbackDialog({ paperId }: { paperId: string }) {
  const [selection, setSelection] = useState<AppEvents["open-term-feedback"] | null>(null);
  useEffect(() => onAppEvent("open-term-feedback", setSelection), []);
  return <Dialog open={!!selection} onOpenChange={open => { if (!open) setSelection(null); }}>
    <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
      <DialogTitle>気になる訳語を修正</DialogTitle>
      <DialogDescription>論文内の訳語をまとめて直し、次の翻訳にも反映できます。</DialogDescription>
      {selection && <TermFeedback key={`${paperId}:${selection.side}:${selection.text}`} paperId={paperId} selection={selection} />}
    </DialogContent>
  </Dialog>;
}

/** The term card of a selected word (what it is called in this paper, where, and how else), then the change to make. */
export function TermFeedback({ paperId, selection }: { paperId: string; selection?: AppEvents["open-term-feedback"] }) {
  // What the user typed or picked; null keeps what the card (or nothing, without a selection) says.
  const [sourceInput, setSourceInput] = useState<string | null>(null);
  const [beforeInput, setBeforeInput] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [editing, setEditing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [shared, setShared] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [applied, setApplied] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [research, setResearch] = useState<TermResearchResult | null>(null);
  const busy = useStore(s => paperBusy(s.activeJobs, paperId));
  const { data: settings } = useSettings();
  const { data: providers } = useProviders();
  // What the card is asked about: the selection (none when it is blank), then a term picked from candidates or just changed.
  const [request, setRequest] = useState<{ side: "original" | "translated"; text: string } | null>(
    selection && selection.text.trim() ? { side: selection.side, text: selection.text.trim().slice(0, 100) } : null);
  const { data: answer, isLoading: cardLoading, error: cardError, refetch: retryCard, isFetching: cardFetching } = useQuery({
    queryKey: [QK.termCard, paperId, request], enabled: !!request, retry: false, gcTime: 0,
    queryFn: async () => await unwrap(api.POST("/api/papers/{paper_id}/term-card", {
      params: { path: { paper_id: paperId } }, body: request!,
    })) as CardAnswer,
  });
  // The card of one term; with several matches the user picks one and the card is asked for again (the candidates carry counts only).
  const card: Card | null = answer?.source && answer.current ? answer : null;
  const choosing = !card && !!answer?.candidates.length;
  const source = sourceInput ?? card?.source ?? answer?.source ?? "";
  const before = beforeInput ?? card?.current ?? answer?.current ?? "";
  // Nothing to type into while the card is loading or while a term is to be picked from the candidates.
  const showFields = !cardLoading && !choosing && (!card || editing);
  const showTarget = !cardLoading && !choosing && (!card || changing);
  const webAvailable = providers?.find(p => p.id === settings?.provider)?.web_search === true;
  const ready = !cardLoading && !choosing && !!source.trim() && !!before.trim() && !!target.trim() && before.trim() !== target.trim();

  // The preview follows the inputs once they stop changing; there is no button in between.
  const [asked, setAsked] = useState<Asked | null>(null);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setAsked({ source, before, target }), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready, source, before, target]);
  // Only an answer to what is typed now is shown, and only that can be applied.
  const current = ready && asked?.source === source && asked.before === before && asked.target === target;
  const { data: preview, isFetching: previewing, error: previewError } = useQuery({
    queryKey: [QK.termPreview, paperId, asked], enabled: !!asked && current && !applied, gcTime: 0, retry: false,
    queryFn: async () => await unwrap(api.POST("/api/papers/{paper_id}/term-replacement-preview", {
      params: { path: { paper_id: paperId } }, body: asked!,
    })) as Preview,
  });
  const shown: Preview | null = current && !applied && preview ? preview : null;
  const checked = shown ? shown.changes.filter(c => !excluded.includes(c.id)).map(c => c.id) : [];
  // Entries of the shared dictionary for this source that saving to it would sit beside or replace.
  const otherEntries = (card?.dictionary ?? []).filter(entry => entry.target !== target.trim());

  const edit = (setter: (s: string) => void, value: string) => {
    setter(value); setExcluded([]); setApplied(false); setMessage(""); setError("");
  };
  // A variant is the wording to replace; the new translation then defaults to the one in use, so the preview shows at once.
  const pickVariant = (variant: string) => {
    if (!card) return;
    const picked = before === variant;
    edit(setBeforeInput, picked ? card.current : variant);
    setChanging(true);
    if (!picked && !target.trim()) setTarget(card.current);
    else if (picked && target === card.current) setTarget("");
  };
  // Start over from a term: its card, and nothing typed.
  const restart = (text: string) => {
    setRequest({ side: "original", text: text.trim().slice(0, 100) });
    setSourceInput(null); setBeforeInput(null); setTarget(""); setEditing(false); setChanging(false);
    setExcluded([]); setResearch(null);
  };
  const lookup = async () => {
    setPending(true); setResearch(null); setMessage("");
    try {
      await startJob(`/api/papers/${paperId}/term-research`, { source: source.trim() }, { kind: "term-research", paperId }, event => {
        setPending(false);
        if (event.status === "succeeded") setResearch(event.result);
      });
    } catch (error) { setPending(false); showError(error, "訳語を調べられませんでした"); }
  };
  const apply = async () => {
    if (!shown) return;
    setPending(true); setMessage(""); setError("");
    try {
      await startJob(`/api/papers/${paperId}/term-replacement`, {
        source, before, target, expected_key: shown.key, selected_ids: checked, remember: shared ? "shared" : "paper",
      }, { kind: "term-replace", paperId }, event => {
        setPending(false);
        // A failed or stopped job leaves the preview as it was, to try again.
        if (event.status !== "succeeded") { setError(event.status === "cancelled" ? "中止しました。" : event.error || "不明なエラー"); return; }
        setApplied(true);
        const kept = event.result.remember === "shared" ? "ほかの論文でも優先します。" : "";
        setMessage(event.result.changed
          ? `${event.result.changed}段落の訳語を置き換えました。この論文の次の翻訳でもこの訳語を使います。${kept}`
          : `この論文の次の翻訳からこの訳語を使います。${kept}`);
        // The card now shows the new translation in use, and the next change starts from it.
        restart(source);
      });
    } catch (error) { setPending(false); showError(error, "訳語を反映できませんでした"); }
  };
  const lookupButton = <Button variant="outline" size="sm" disabled={!source.trim() || !webAvailable} onClick={() => void lookup()}>Webで日本語の用例を調べる</Button>;
  return <section className="space-y-3 text-sm" aria-label="訳語の一括修正">
    <p className="text-muted-foreground">訳語は翻訳時に自動で統一します。気になる語があれば、ここで直せます。</p>
    <fieldset disabled={pending || busy} className="space-y-3">
      {cardLoading && <p role="status" className="text-muted-foreground">訳語を調べています…</p>}
      {cardError && <div role="alert" className="flex flex-wrap items-center gap-2 text-destructive">
        <span>訳語カードを取得できませんでした。{cardError instanceof Error ? cardError.message : ""}原語と訳語は入力できます。</span>
        <Button variant="outline" size="sm" disabled={cardFetching} onClick={() => void retryCard()}>再試行</Button>
      </div>}
      {choosing && <div className="space-y-1">
        <p>どの語を直しますか。</p>
        <div className="flex flex-wrap gap-2">
          {answer.candidates.map((c, i) => <Button key={i} variant="outline" size="sm" onClick={() => restart(c.source)}>{c.source} → {c.current}（{c.count}段落）</Button>)}
        </div>
      </div>}
      {card && <div role="group" className="rounded border p-3 space-y-2" aria-label="訳語カード">
        <p className="text-base"><strong>{card.source} → {card.current}</strong>（{card.count}段落）</p>
        {!!card.variants.length && <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">表記揺れ</span>
          {card.variants.map(v => <Button key={v.text} variant={before === v.text ? "default" : "outline"} size="sm" aria-pressed={before === v.text}
            title="この表記を置き換える対象にします" onClick={() => pickVariant(v.text)}>{v.text} {v.count}段落</Button>)}
        </div>}
        {card.missing > 0 && <p className="text-xs text-muted-foreground">原語を含むのに「{card.current}」が見当たらないのは{card.missing}段落です。</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={changing} onClick={() => setChanging(true)}>訳を変える</Button>
          {!editing && <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>変更</Button>}
          {lookupButton}
        </div>
      </div>}
      {showFields && <div className="space-y-2">
        {!card && !!answer?.source_candidates.length && <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">原語の候補</span>
          {answer.source_candidates.map(c => <Button key={c.text} variant={source === c.text ? "default" : "outline"} size="sm" aria-pressed={source === c.text}
            title="この訳語の原文に共通して出る語句です" onClick={() => { edit(setSourceInput, c.text); setResearch(null); }}>{c.text} {c.count}段落</Button>)}
        </div>}
        <div className="grid grid-cols-2 gap-3">
          <label>原語（英語）<Input aria-label="修正する原語" maxLength={100} value={source} onChange={e => { edit(setSourceInput, e.target.value); setResearch(null); }} placeholder="例：policy" /></label>
          <label>現在の訳語<Input aria-label="置換前の訳語" maxLength={100} value={before} onChange={e => edit(setBeforeInput, e.target.value)} placeholder="例：ポリシー" /></label>
        </div>
      </div>}
      {!card && !cardLoading && !choosing && lookupButton}
      <p className="text-xs text-muted-foreground">Web調査は学会・大学・公的機関の原文の用例を参照します。機械翻訳の訳語は根拠にしません。AIの利用枠を使います。{!webAvailable && "Web検索対応のAI接続が必要です。"}</p>
      {research && <div className="space-y-2">
        {!research.candidates.length && <p>信頼できる出典で、この文脈に合う日本語の用例を確認できませんでした。</p>}
        {research.candidates.map((candidate, i) => <div key={i} className="rounded border p-3 space-y-2">
          <div className="flex gap-2 items-center"><strong>{candidate.target}</strong><Button variant="outline" size="sm" onClick={() => { edit(setTarget, candidate.target); setChanging(true); }}>この訳語を入力</Button></div>
          <p>{candidate.explanation}</p>
          {candidate.sources.map((entry, j) => <div key={j}><button type="button" className="text-primary underline text-left" onClick={() => void shell.openUrl(entry.url).catch(error => showError(error, "出典を開けませんでした"))}>{entry.title}</button><blockquote className="text-xs text-muted-foreground">{entry.quote}</blockquote></div>)}
        </div>)}
      </div>}
      {showTarget && <label className="block">{card ? "新しい訳語" : "使いたい訳語"}<Input aria-label="置換後の訳語" autoFocus={!!card} maxLength={100} value={target} onChange={e => edit(setTarget, e.target.value)} placeholder="例：方策" /></label>}
      {ready && !applied && <div role="group" className="space-y-2" aria-label="置換の確認">
        {(!current || previewing) && <p role="status" className="text-muted-foreground">置換箇所を確認しています…</p>}
        {previewError && current && <p role="alert" className="text-destructive">置換箇所を確認できませんでした。{previewError instanceof Error ? previewError.message : ""}</p>}
        {shown && <>
          <p>{shown.changes.length ? `${shown.changes.length}段落が該当します。` : "置き換える段落はありません。"}
            置換は表記の部分一致で、「{before}」を含む語の中も置き換わります。変更前後を確認し、別の意味の箇所はチェックを外してください。</p>
          <div className="max-h-64 overflow-y-auto space-y-2">
            {shown.changes.map(c => <label key={c.id} className="block border rounded p-3 space-y-2">
              <span className="flex gap-2"><input type="checkbox" aria-label={`p.${c.pages.join(", ")} の段落を置換する`} checked={checked.includes(c.id)} onChange={e => setExcluded(ids => e.target.checked ? ids.filter(id => id !== c.id) : [...ids, c.id])} />p.{c.pages.join(", ")}</span>
              <span className="block text-xs text-muted-foreground whitespace-pre-wrap">原文：{c.source}</span>
              <span className="block whitespace-pre-wrap">変更前：{c.text}</span>
              <span className="block whitespace-pre-wrap">変更後：{c.after}</span>
            </label>)}
          </div>
          {!checked.length && <p className="text-muted-foreground">現在の訳文は変更せず、次の翻訳に使う訳語だけを保存します。</p>}
          <label className="flex items-center gap-2"><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />他の論文でもこの訳語を優先する</label>
          <p className="text-xs text-muted-foreground">この論文では常にこの訳語を使います。チェックすると辞書にも登録します（同じ原語の辞書の訳は置き換わります）。ほかの論文は次の翻訳から反映します。</p>
          {shared && !!otherEntries.length && <p className="text-xs">辞書に「{source}」の訳が既にあります：{otherEntries.map(e => `${e.target}（${e.domain || "共通"}）`).join("、")}。この論文の分野の同じ原語の訳は置き換わります。</p>}
          <Button onClick={() => void apply()}>{checked.length ? `${checked.length}段落を置換してPDFに反映` : "今後の訳語だけ保存"}</Button>
        </>}
      </div>}
    </fieldset>
    {pending && <p role="status">処理中…</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="text-destructive">訳語を反映できませんでした。{error}</p>}
  </section>;
}
