import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { useProviders, useSettings } from "@/api/hooks";
import type { TermResearchResult } from "@/api/jobTypes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { showError } from "@/components/errorDialog";
import { startJob } from "@/features/jobs/jobEvents";
import { paperBusy, useStore } from "@/store";
import { onAppEvent, type AppEvents } from "@/lib/appEvents";
import { shell } from "@/shell";
import { QK } from "@/lib/queryKeys";

type Preview = { key: string; changes: { id: string; pages: number[]; source: string; text: string; after: string }[] };

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

export function TermFeedback({ paperId, selection }: { paperId: string; selection?: AppEvents["open-term-feedback"] }) {
  const [sourceOverride, setSource] = useState<string | null>(selection?.side === "original" ? selection.text.slice(0, 100) : null);
  const [before, setBefore] = useState(selection?.side === "translated" ? selection.text.slice(0, 100) : "");
  const [target, setTarget] = useState("");
  const [remember, setRemember] = useState<"none" | "paper" | "shared">("paper");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [research, setResearch] = useState<TermResearchResult | null>(null);
  const busy = useStore(s => paperBusy(s.activeJobs, paperId));
  const { data: settings } = useSettings();
  const { data: providers } = useProviders();
  const { data: terms = [] } = useQuery({ queryKey: [QK.effectiveGlossary, paperId],
    queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/effective-glossary", {
      params: { path: { paper_id: paperId } },
    })) as { source: string; target: string }[], enabled: selection?.side === "translated" });
  const inferred = terms.filter(term => term.target === selection?.text.trim());
  const source = sourceOverride ?? (inferred.length === 1 ? inferred[0].source : "");
  const webAvailable = providers?.find(p => p.id === settings?.provider)?.web_search === true;
  const change = (setter: (s: string) => void, value: string) => {
    setter(value); setPreview(null); setChecked([]); setMessage("");
    if (setter === setSource) setResearch(null);
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
  const inspect = async () => {
    setPending(true); setMessage("");
    try {
      const value = await unwrap(api.POST("/api/papers/{paper_id}/term-replacement-preview", {
        params: { path: { paper_id: paperId } }, body: { source, before, target },
      })) as Preview;
      setPreview(value); setChecked(value.changes.map(c => c.id));
    } catch (error) { showError(error, "置換箇所を確認できませんでした"); }
    finally { setPending(false); }
  };
  const apply = async () => {
    if (!preview) return;
    setPending(true); setMessage("");
    try {
      await startJob(`/api/papers/${paperId}/term-replacement`, {
        source, before, target, expected_key: preview.key, selected_ids: checked, remember,
      }, { kind: "term-replace", paperId }, event => {
        setPending(false);
        setPreview(null); setChecked([]);
        if (event.status === "succeeded") setMessage(`${event.result.changed}段落の訳語を置き換えました。${event.result.remember === "shared" ? "今後、同じ分野の論文でもこの訳語を使います。" : event.result.remember === "paper" ? "この論文の次の翻訳でもこの訳語を使います。" : ""}`);
      });
    } catch (error) { setPending(false); showError(error, "訳語を反映できませんでした"); }
  };
  return <section className="space-y-3 text-sm" aria-label="訳語の一括修正">
    <p className="text-muted-foreground">訳語は翻訳時に自動で統一します。気になる語があれば、ここで直せます。</p>
    <fieldset disabled={pending || busy} className="space-y-3">
      <label className="block">原語（英語）<Input aria-label="修正する原語" maxLength={100} value={source} onChange={e => change(setSource, e.target.value)} placeholder="例：policy" /></label>
      <div className="grid grid-cols-2 gap-3">
        <label>現在の訳語<Input aria-label="置換前の訳語" maxLength={100} value={before} onChange={e => change(setBefore, e.target.value)} placeholder="例：ポリシー" /></label>
        <label>使いたい訳語<Input aria-label="置換後の訳語" maxLength={100} value={target} onChange={e => change(setTarget, e.target.value)} placeholder="例：方策" /></label>
      </div>
      <Button variant="outline" disabled={!source.trim() || !webAvailable} onClick={() => void lookup()}>Webで日本語の用例を調べる</Button>
      <p className="text-xs text-muted-foreground">学会・大学・公的機関の原文の用例を参照します。機械翻訳の訳語は根拠にしません。調査にはAIの利用枠を使います。{!webAvailable && "Web検索対応のAI接続が必要です。"}</p>
      {research && <div className="space-y-2">
        {!research.candidates.length && <p>信頼できる出典で、この文脈に合う日本語の用例を確認できませんでした。</p>}
        {research.candidates.map((candidate, i) => <div key={i} className="rounded border p-3 space-y-2">
          <div className="flex gap-2 items-center"><strong>{candidate.target}</strong><Button variant="outline" size="sm" onClick={() => change(setTarget, candidate.target)}>この訳語を入力</Button></div>
          <p>{candidate.explanation}</p>
          {candidate.sources.map((entry, j) => <div key={j}><button type="button" className="text-primary underline text-left" onClick={() => void shell.openUrl(entry.url).catch(error => showError(error, "出典を開けませんでした"))}>{entry.title}</button><blockquote className="text-xs text-muted-foreground">{entry.quote}</blockquote></div>)}
        </div>)}
      </div>}
      <label className="block">今後の翻訳への反映<NativeSelect aria-label="訳語の保存範囲" value={remember} onChange={e => setRemember(e.target.value as typeof remember)}>
        <option value="paper">この論文でも引き続き使う</option>
        <option value="shared">今後、同じ分野の論文にも使う</option>
        <option value="none">今回の置換だけ</option>
      </NativeSelect></label>
      {remember === "shared" && <p className="text-xs text-muted-foreground">この論文の主な分野の辞書に保存します。分野が未設定なら共通辞書に保存します。他の論文の保存済み訳文は、各論文の次の翻訳で反映されます。</p>}
      <Button variant="outline" disabled={!source.trim() || !before.trim() || !target.trim() || before.trim() === target.trim()} onClick={() => void inspect()}>置換箇所を確認</Button>
      {preview && <div className="space-y-2">
        <p>{preview.changes.length}段落が該当します。原語を含む段落の同じ表記を置換します。別の意味の箇所はチェックを外してください。</p>
        <div className="max-h-64 overflow-y-auto space-y-2">
          {preview.changes.map(c => <label key={c.id} className="block border rounded p-3 space-y-2">
            <span className="flex gap-2"><input type="checkbox" checked={checked.includes(c.id)} onChange={e => setChecked(ids => e.target.checked ? [...ids, c.id] : ids.filter(id => id !== c.id))} />p.{c.pages.join(", ")}</span>
            <span className="block text-xs text-muted-foreground whitespace-pre-wrap">原文：{c.source}</span>
            <span className="block whitespace-pre-wrap">変更前：{c.text}</span>
            <span className="block whitespace-pre-wrap">変更後：{c.after}</span>
          </label>)}
        </div>
        {!checked.length && remember !== "none" && <p className="text-muted-foreground">現在の訳文は変更せず、次の翻訳に使う訳語だけを保存します。</p>}
        <Button disabled={!checked.length && remember === "none"} onClick={() => void apply()}>{checked.length ? `${checked.length}段落を置換してPDFに反映` : "今後の訳語を保存"}</Button>
      </div>}
    </fieldset>
    {pending && <p role="status">処理中…</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
