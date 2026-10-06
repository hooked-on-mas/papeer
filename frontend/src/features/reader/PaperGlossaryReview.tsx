import { useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { invalidate } from "@/api/mutations";
import { QK } from "@/lib/queryKeys";
import { useSessionState } from "@/lib/useSessionState";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { applyGlossaryReview, sourceKey, type PaperGlossary } from "./paperGlossary";
import { domainNameOf } from "./glossaryDomains";
import { normalizeTerms, type GlossaryCandidate, type Term } from "./translationStart";

const empty: PaperGlossary = { terms: [], dismissed: [] };

export function usePaperGlossaryEditor(session: string | null, paperId: string) {
  const client = useQueryClient();
  const { data: saved, isFetching: fetching } = useQuery({ queryKey: [QK.paperGlossary, paperId],
    queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/glossary", {
      params: { path: { paper_id: paperId } } })) as PaperGlossary, enabled: session !== null });
  const [state, update] = useSessionState(session, () => ({ edits: null as PaperGlossary | null,
    base: empty, candidates: [] as GlossaryCandidate[], selected: new Set<string>(), search: "" }));
  const base = state.edits ?? saved ?? empty;
  const edited = applyGlossaryReview(base, state.candidates, state.selected);
  const edit = (terms: Term[]) => update({ edits: { ...base, terms }, base: state.edits ? state.base : saved ?? empty });
  return {
    saved, fetching, terms: base.terms, effective: edited.terms, candidates: state.candidates, selected: state.selected,
    dirty: !!state.edits || state.selected.size > 0,
    search: state.search,
    setSearch: (search: string) => update({ search }),
    addRow: () => {
      edit([...base.terms, { source: "", target: "" }]);
      update({ search: "" });
    },
    override: (term: Term) => {
      const key = sourceKey(term.source);
      edit([...base.terms.filter((t) => sourceKey(t.source) !== key), { source: term.source, target: term.target }]);
      const selected = new Set(state.selected);
      selected.delete(key);
      update({ candidates: state.candidates.filter((t) => sourceKey(t.source) !== key), selected });
    },
    addCandidates: (candidates: GlossaryCandidate[]) => {
      const known = new Set([...base.terms.map((t) => sourceKey(t.source)), ...base.dismissed]);
      const next = candidates.filter((t) => !known.has(sourceKey(t.source)));
      update({ candidates: next, selected: new Set() });
      return next.length;
    },
    toggle: (source: string, checked: boolean) => {
      const selected = new Set(state.selected);
      if (checked) selected.add(sourceKey(source)); else selected.delete(sourceKey(source));
      update({ selected });
    },
    setCandidateTarget: (source: string, target: string) => update({ candidates: state.candidates.map((t) => t.source === source ? { ...t, target } : t) }),
    setSource: (index: number, source: string) => edit(base.terms.map((t, i) => i === index ? { ...t, source } : t)),
    setTarget: (index: number, target: string) => edit(base.terms.map((t, i) => i === index ? { ...t, target } : t)),
    remove: (index: number) => edit(base.terms.filter((_, i) => i !== index)),
    save: async () => {
      if (!state.edits && !state.candidates.length) return;
      const next = { ...edited, terms: normalizeTerms(edited.terms) };
      await unwrap(api.PUT("/api/papers/{paper_id}/glossary", { params: { path: { paper_id: paperId } },
        body: { ...next, expected: state.edits ? state.base : saved ?? empty } }));
      client.setQueryData([QK.paperGlossary, paperId], next);
      update({ edits: null, candidates: [], selected: new Set() });
      await invalidate({ kind: "paperGlossary", paperId }, client);
    },
  };
}

export function PaperGlossaryReview({ editor, sharedTerms, busy, onShare, dictionarySettings }: {
  editor: ReturnType<typeof usePaperGlossaryEditor>; sharedTerms: readonly Term[];
  busy: boolean; onShare: (term: Term, domain?: string) => void;
  dictionarySettings?: ReactNode;
}) {
  const rowsRef = useRef<HTMLDivElement>(null);
  const targetsRef = useRef(new Map<string, HTMLInputElement>());
  const searchRef = useRef<HTMLInputElement>(null);
  const focusRequest = useRef<"source" | { target: string } | null>(null);
  useEffect(() => {
    if (!focusRequest.current) return;
    // Replacing the focused dictionary row makes the dialog restore focus first.
    // Focus the new input on the following frame, after that restoration.
    let focusFrame = 0;
    const frame = requestAnimationFrame(() => { focusFrame = requestAnimationFrame(() => {
      const request = focusRequest.current;
      if (request === "source") {
        const inputs = rowsRef.current?.querySelectorAll<HTMLInputElement>('input[data-paper-source]');
        inputs?.[inputs.length - 1]?.focus();
      } else if (request) targetsRef.current.get(request.target)?.focus();
      focusRequest.current = null;
    }); });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame); };
  }, [editor.terms]);
  const localSources = new Set(editor.terms.map((t) => sourceKey(t.source)));
  const inherited = sharedTerms.filter((t) => !localSources.has(sourceKey(t.source)));
  const inheritedDomains = [...new Set(inherited.map(domainNameOf))];
  const shown = editor.terms.map((term, index) => ({ term, index })).filter(({ term }) => !term.source.trim()
    || `${term.source} ${term.target}`.toLocaleLowerCase().includes(editor.search.trim().toLocaleLowerCase()));
  return <section aria-label="この論文に使う訳語" className="space-y-3 text-[0.8125rem]">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">指定した訳語（{editor.terms.length}件）</h3>
      <Button variant="outline" disabled={busy || !editor.saved} onClick={() => {
        focusRequest.current = "source";
        editor.addRow();
      }}>訳語を追加</Button>
    </div>
    {(editor.terms.length > 5 || editor.search) && <div className="flex gap-1">
      <Input ref={searchRef} aria-label="この論文の訳語を検索" placeholder="原語・日本語訳を検索" value={editor.search} onChange={e => editor.setSearch(e.target.value)} />
      {editor.search && <Button variant="ghost" aria-label="この論文の訳語の検索を解除" onClick={() => { editor.setSearch(""); searchRef.current?.focus(); }}>解除</Button>}
    </div>}
    <fieldset disabled={busy} className="min-w-0">
      <div ref={rowsRef} className="space-y-2">
        {!shown.length && <div role="status" className="rounded-lg border border-dashed p-4 text-muted-foreground">
          {editor.terms.length ? "一致する訳語がありません。検索語を変えてください。" : <>まだ訳語を指定していません。<br />「訳語を追加」から、使いたい訳し方を入力できます。</>}
        </div>}
        {shown.map(({ term, index }) => {
          const original = sharedTerms.find((t) => sourceKey(t.source) === sourceKey(term.source));
          const label = term.source || `用語 ${index! + 1}`;
          return <div key={`paper:${index}`} className="rounded-lg border p-3 space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1"><span className="text-xs text-muted-foreground">原語</span>
                  <Input data-paper-source aria-label={`この論文の原語 ${index + 1}`} placeholder="例：control" maxLength={100} value={term.source} onChange={e => editor.setSource(index, e.target.value)} /></label>
                <label className="space-y-1"><span className="text-xs text-muted-foreground">使いたい日本語訳</span>
                  <Input ref={el => { if (el) targetsRef.current.set(sourceKey(term.source), el); else targetsRef.current.delete(sourceKey(term.source)); }}
                    aria-label={`${label}の指定訳`} placeholder="例：制御" maxLength={100} value={term.target} onChange={e => editor.setTarget(index, e.target.value)} /></label>
              </div>
              {original && <p className="text-xs text-muted-foreground break-words">辞書の訳：{original.target}（{domainNameOf(original)}）</p>}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button variant="ghost" size="sm" aria-label={`${label}の論文限定指定を解除`} onClick={() => editor.remove(index)}>{original ? "辞書の訳に戻す" : "削除"}</Button>
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">ほかの論文でも使いたいとき</summary>
                  <Button className="mt-2" variant="outline" disabled={!term.source.trim() || !term.target.trim()} onClick={() => onShare(term, original ? domainNameOf(original) : undefined)}>ほかの論文でも使う</Button>
                </details>
              </div>
          </div>;
        })}
      </div>
    </fieldset>
    {editor.candidates.length > 0 && <fieldset disabled={busy} className="space-y-2">
      <p className="font-medium">AIからの提案（{editor.candidates.length}件）</p>
      <p className="text-muted-foreground">使いたい候補にチェックして保存してください。選ばない候補は保存時に閉じ、同じ論文では再提案しません。</p>
      {editor.candidates.map((term) => <div key={term.source} className="border rounded p-2 space-y-1">
        <label className="flex items-center gap-2 font-medium"><input type="checkbox"
          checked={editor.selected.has(sourceKey(term.source))} onChange={(e) => editor.toggle(term.source, e.target.checked)} />{term.source}</label>
        <Input aria-label={`${term.source}の推奨訳`} value={term.target} onChange={(e) => editor.setCandidateTarget(term.source, e.target.value)} />
        {term.reason && <p>{term.reason}</p>}
        {term.context && <details><summary className="cursor-pointer text-muted-foreground">原文の使われ方</summary><p className="whitespace-pre-wrap">{term.context}</p></details>}
      </div>)}
    </fieldset>}
    {dictionarySettings}
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer font-medium">辞書から使う訳語を確認（{sharedTerms.length}件）</summary>
      <div className="mt-3 space-y-3">
        <p className="text-muted-foreground">共通と選択した分野から使う訳語の合計です。違う訳し方にしたい語は「この論文だけ変更」を押してください。</p>
        <fieldset disabled={busy} className="min-w-0 space-y-2">
          {inheritedDomains.map(domain => <section key={domain} aria-label={`${domain}の訳語`} className="space-y-2">
            <h4 className="font-medium pt-2">{domain}（{inherited.filter(t => domainNameOf(t) === domain).length}件）</h4>
          {inherited.filter(t => domainNameOf(t) === domain).map(term => <div key={term.source} className="rounded-lg border p-3 space-y-2">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-medium break-all">{term.source} → {term.target}</span>
              <span className="text-xs text-muted-foreground">辞書・{domainNameOf(term)}</span>
            </div>
            <Button variant="outline" size="sm" aria-label={`${term.source}をこの論文だけ変更`} onClick={() => {
              focusRequest.current = { target: sourceKey(term.source) };
              editor.override(term);
            }}>この論文だけ変更</Button>
          </div>)}
          </section>)}
          {!inherited.length && <p className="text-muted-foreground">{sharedTerms.length ? "辞書の訳語は、上の指定で変更しています。" : "この論文に使う辞書の訳語はありません。"}</p>}
        </fieldset>
      </div>
    </details>
  </section>;
}
