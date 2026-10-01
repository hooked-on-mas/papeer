import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { invalidate } from "@/api/mutations";
import { QK } from "@/lib/queryKeys";
import { useSessionState } from "@/lib/useSessionState";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { applyGlossaryReview, sourceKey, type PaperGlossary } from "./paperGlossary";
import { normalizeTerms, type GlossaryCandidate, type Term } from "./translationStart";

const empty: PaperGlossary = { terms: [], dismissed: [] };

export function usePaperGlossaryEditor(session: string | null, paperId: string) {
  const client = useQueryClient();
  const { data: saved, isFetching: fetching } = useQuery({ queryKey: [QK.paperGlossary, paperId],
    queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/glossary", {
      params: { path: { paper_id: paperId } } })) as PaperGlossary, enabled: session !== null });
  const [state, update] = useSessionState(session, () => ({ edits: null as PaperGlossary | null,
    base: empty, candidates: [] as GlossaryCandidate[], selected: new Set<string>() }));
  const base = state.edits ?? saved ?? empty;
  const edited = applyGlossaryReview(base, state.candidates, state.selected);
  const edit = (terms: Term[]) => update({ edits: { ...base, terms }, base: state.edits ? state.base : saved ?? empty });
  return {
    saved, fetching, terms: base.terms, effective: edited.terms, candidates: state.candidates, selected: state.selected,
    dirty: !!state.edits || state.selected.size > 0,
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

export function PaperGlossaryReview({ editor, busy, onShare }: {
  editor: ReturnType<typeof usePaperGlossaryEditor>; busy: boolean; onShare: (term: Term) => void;
}) {
  return <div className="space-y-2 text-[0.8125rem]">
    {editor.candidates.length > 0 && <fieldset disabled={busy} className="space-y-2">
      <p className="font-medium">訳語の確認（最大5件）</p>
      <p className="text-muted-foreground">使いたい訳語だけ選ぶと、この論文に適用します。選ばない語は次回から確認しません。</p>
      {editor.candidates.map((term) => <div key={term.source} className="border rounded p-2 space-y-1">
        <label className="flex items-center gap-2 font-medium"><input type="checkbox"
          checked={editor.selected.has(sourceKey(term.source))} onChange={(e) => editor.toggle(term.source, e.target.checked)} />{term.source}</label>
        <Input aria-label={`${term.source}の推奨訳`} value={term.target} onChange={(e) => editor.setCandidateTarget(term.source, e.target.value)} />
        {term.reason && <p>{term.reason}</p>}
        {term.context && <details><summary className="cursor-pointer text-muted-foreground">原文の使われ方</summary><p className="whitespace-pre-wrap">{term.context}</p></details>}
      </div>)}
    </fieldset>}
    {editor.terms.length > 0 && <details className="border rounded p-2">
      <summary className="cursor-pointer font-medium">この論文の訳語指定（{editor.terms.length}件）</summary>
      <fieldset disabled={busy} className="space-y-2 mt-2">
        {editor.terms.map((term, index) => <div key={term.source} className="space-y-1">
          <p>{term.source}</p>
          <Input aria-label={`${term.source}の指定訳`} value={term.target} onChange={(e) => editor.setTarget(index, e.target.value)} />
          <div className="flex gap-2"><Button variant="outline" onClick={() => editor.remove(index)}>指定を解除</Button>
            <Button variant="outline" onClick={() => onShare(term)}>共用辞書に追加</Button></div>
        </div>)}
      </fieldset>
    </details>}
  </div>;
}
