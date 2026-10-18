import { useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { showError } from "@/components/errorDialog";
import { askText } from "@/components/AppDialogs";
import { fetchGlossary, useSaveGlossary } from "@/api/mutations";
import { QK } from "@/lib/queryKeys";
import { useSessionState } from "@/lib/useSessionState";
import { GlossaryTransfer } from "./GlossaryTransfer";
import { checkedDomains, countDomainTerms, domainNameOf, domainNamesIn, inDomainFilter, toggledChoice, withDomain, type PaperDomains } from "./glossaryDomains";
import { moveGlossaryTerms } from "./paperGlossary";
import { GENERAL_DOMAIN, normalizeTerms, type Term } from "./translationStart";

type GlossaryView = "all" | "new" | "existing";

type EditorState = {
  /** The list as edited, or null while it is the saved glossary as it is: nothing changed since the dialog opened or saved. */
  edits: Term[] | null;
  /** The saved glossary the edits started from: saving is refused when it has changed meanwhile. */
  base: Term[];
  /** Sources of the terms added this time (the AI's candidates, a file read in, rows added by hand), marked 「新規」. */
  newSources: Set<string>;
  search: string;
  view: GlossaryView;
  /** The dictionary the list is narrowed to (a domain's name, or 共通); null: all of them. */
  domainFilter: string | null;
  expanded: boolean;
  undo: Term[] | null;
};

const initialState = (): EditorState => ({ edits: null, base: [], newSources: new Set(), search: "", view: "all", domainFilter: null, expanded: false, undo: null });

/** The longest name of a domain dictionary (the sidecar refuses a longer one). */
const MAX_DOMAIN_LENGTH = 40;

/** The value of the option that asks for the name of a new domain dictionary. */
const NEW_DOMAIN = "__new-domain__";

/**
 * The common glossary as the translation dialog edits it: the saved glossary (GET /api/glossary) until
 * the user changes it, then the edited list, until it is saved. Started over each time the dialog opens
 * (`session`: the paper's id while it is open, else null).
 */
export function useGlossaryEditor(session: string | null) {
  const { data: saved, isFetching: fetching } = useQuery({ queryKey: [QK.glossary], queryFn: fetchGlossary, enabled: session !== null });
  const [state, update] = useSessionState(session, initialState);
  const saveGlossary = useSaveGlossary();
  const terms = state.edits ?? saved ?? [];
  const dirty = state.edits !== null;
  const edit = (change: (terms: Term[]) => Term[], more: (state: EditorState) => Partial<EditorState> = () => ({})) =>
    update((s) => ({ ...more(s), undo: s.edits ?? saved ?? [], edits: change(s.edits ?? saved ?? []), base: s.edits ? s.base : saved ?? [] }));
  return {
    /** The saved glossary; undefined until it has loaded. */
    saved,
    /** The saved glossary is being read (again): what was cached may be out of date. */
    fetching,
    terms,
    dirty,
    newSources: state.newSources,
    search: state.search,
    view: state.view,
    domainFilter: state.domainFilter,
    expanded: state.expanded,
    setSearch: (search: string) => update({ search }),
    setView: (view: GlossaryView) => update({ view }),
    setDomainFilter: (domainFilter: string | null) => update({ domainFilter }),
    setExpanded: (expanded: boolean) => update({ expanded }),
    canUndo: state.undo !== null,
    undo: () => {
      if (!state.undo) return;
      if (JSON.stringify(state.undo) === JSON.stringify(state.base)) update({ edits: null, undo: terms });
      else edit(() => state.undo!);
    },
    moveTerms: (selected: ReadonlySet<number>, domain: string) => edit((list) => moveGlossaryTerms(list, selected, domain)),
    previewSplit: (list: Record<string, string>[], original: Record<string, string>[]) => {
      const asTerms = (items: Record<string, string>[]) => items.map((t) => ({ source: t.source, target: t.target, ...(t.domain ? { domain: t.domain } : {}) }));
      update({ edits: asTerms(list), base: asTerms(original), undo: asTerms(original),
        expanded: true, view: "all", search: "", domainFilter: null });
    },
    setSource: (index: number, source: string) => edit((list) => list.map((v, i) => i === index ? { ...v, source } : v), (s) => {
      const previous = (s.edits ?? saved ?? [])[index]?.source;
      if (previous === undefined || !s.newSources.has(previous)) return {};
      const newSources = new Set(s.newSources);
      newSources.delete(previous);
      newSources.add(source);
      return { newSources };
    }),
    setTarget: (index: number, target: string) => edit((list) => list.map((v, i) => i === index ? { ...v, target } : v)),
    /** Moves a term to a domain dictionary (or 共通: no `domain` key). */
    setDomain: (index: number, domain: string) => edit((list) => list.map((v, i) => i === index ? withDomain(v, domain) : v)),
    removeTerm: (index: number) => edit((list) => list.filter((_, i) => i !== index)),
    /** A row in the dictionary the list is narrowed to, so that it does not vanish from the list. */
    addRow: () => edit((list) => [...list, withDomain({ source: "", target: "" }, state.domainFilter ?? "")],
      (s) => ({ view: "all", search: "", newSources: new Set([...s.newSources, ""]) })),
    /** Candidates merged into the list (`list`, which holds them), shown as 「新規」 under 今回の追加候補. */
    addCandidates: (list: Term[], added: Term[], { expand = false } = {}) => edit(() => list, (s) => ({
      newSources: new Set([...s.newSources, ...added.map((t) => t.source)]), view: "new", search: "", domainFilter: null,
      ...(expand ? { expanded: true } : {}),
    })),
    /** Saves the edited list; settles once the glossary (and what it changes) has been loaded again. */
    save: async () => {
      await saveGlossary.mutateAsync({ terms: normalizeTerms(terms), expected: dirty ? state.base : saved ?? [] });
      update({ edits: null, undo: null });
    },
  };
}

export type GlossaryEditorState = ReturnType<typeof useGlossaryEditor>;

/** The domain dictionaries as the translation dialog offers them: which the paper uses, and the AI's split. */
export type GlossaryDomainsControl = {
  /** GET /api/papers/{id}/glossary-domains; undefined until it has loaded. */
  record: PaperDomains | undefined;
  /** Saves the domain dictionaries the user chose for the paper. */
  onChoose: (domains: string[], newDomain: string | null) => void | Promise<void>;
  /** Starts the AI's split of a dictionary (a domain's name, or 共通). */
  onSplit: (domain: string) => void;
  canSplit: boolean;
  onRefresh?: () => void;
};

/** How the AI's choice (or the user's) is described under the check boxes. */
function choiceNote(record: PaperDomains): string {
  if (record.chosen_by === "ai") return "AIがこの論文の内容から選びました。チェックで変更できます（変更すると、以降はAIによる選び直しをしません）。";
  if (record.chosen_by === "user") return "選択した分野辞書です。チェックで変更できます。";
  return "分野ごとの訳語は、原文の使われ方を確認してから適用します。";
}

/** The domain dictionaries this paper uses: 共通 always, and the ones checked. */
export function DomainChoice({ record, counts, onChoose, children }: { record: PaperDomains; counts: Readonly<Record<string, number>>; onChoose: GlossaryDomainsControl["onChoose"]; children?: ReactNode }) {
  const checked = checkedDomains(record);
  const missing = checked.filter((name) => !record.available.includes(name));
  const newDomain = record.new_domain && !record.available.includes(record.new_domain) ? record.new_domain : null;
  const applied = (record.scope_stale ? [] : record.scope_terms ?? []).filter((term) => checked.includes(domainNameOf(term)));
  const appliedCounts = countDomainTerms(applied);
  return <div className="border rounded-lg p-3 space-y-2 text-[0.8125rem]">
    <p className="font-medium break-words">選択中の分野辞書：{[GENERAL_DOMAIN, ...checked].join("、")}</p>
    <details><summary className="cursor-pointer text-muted-foreground">使う分野を変更</summary>
    <div className="space-y-2 mt-2">
    <label className="flex items-center gap-2"><input type="checkbox" checked disabled />共通（常に適用・{counts[GENERAL_DOMAIN] ?? 0}語）</label>
    {[...record.available, ...missing].map((name) => <label key={name} className="flex items-center gap-2">
      <input type="checkbox" checked={checked.includes(name)}
        onChange={(e) => { const next = toggledChoice(record, name, e.target.checked); onChoose(next.domains, next.newDomain); }} />
      <span>{name}（{missing.includes(name) ? "辞書にない" : `登録${counts[name] ?? 0}語`}
        {checked.includes(name) && !missing.includes(name) && (record.scope_stale ? "・適用を確認中" : `・適用${appliedCounts[name] ?? 0}語`)}）</span>
    </label>)}
    {newDomain && <label className="flex items-center gap-2">
      <input type="checkbox" checked onChange={() => onChoose(checked.filter((name) => record.available.includes(name)), null)} />
      <span>新しい分野「{newDomain}」をこの論文の用語に使う</span>
    </label>}
    <p className="text-xs text-muted-foreground">チェックの変更は自動で保存します。選んだ分野のうち、この論文の文脈に合う訳語を使います。</p>
    <p className="text-xs text-muted-foreground">{choiceNote(record)}</p>
    {record.scope_stale && <p className="text-xs text-muted-foreground">分野の訳語は未確認です。共通と、この論文で指定した訳語を使います。</p>}
    {children}
    </div>
    </details>
  </div>;
}

/** The glossary section of the translation dialog: the domains the paper uses, the AI's check for unregistered terms, the list, and its file import and export. */
export function GlossaryEditor({ editor, transferKey, busy, onPending, domains, saveInFooter = false }: {
  editor: GlossaryEditorState;
  /** Starts the file import and export over (its messages) with each opening. */
  transferKey: string;
  busy: boolean;
  /** A save or a file import or export under way, which holds the dialog. */
  onPending: (pending: boolean) => void;
  domains: GlossaryDomainsControl;
  /** The dialog can keep saving in its fixed footer. */
  saveInFooter?: boolean;
}) {
  const { terms, newSources, view, search, domainFilter } = editor;
  const searchRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [management, setManagement] = useSessionState(transferKey, () => ({
    splitChoice: GENERAL_DOMAIN, selected: new Set<number>(), destination: GENERAL_DOMAIN,
  }));
  const { splitChoice, selected, destination } = management;
  const domainNames = domainNamesIn(terms);
  const counts = countDomainTerms(editor.saved ?? []);
  const splitNames = [GENERAL_DOMAIN, ...domainNamesIn(editor.saved ?? [])];
  // The dictionary chosen to split may have gone (the glossary changed): 共通 then.
  const splitTarget = splitNames.includes(splitChoice) ? splitChoice : GENERAL_DOMAIN;
  const shown = terms.map((item, index) => ({ item, index })).filter(({ item }) =>
    (view === "all" || newSources.has(item.source) === (view === "new")) && inDomainFilter(item, domainFilter) &&
    `${item.source} ${item.target}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const save = async () => {
    onPending(true);
    try { await editor.save(); } catch (error) { showError(error, "辞書を保存できませんでした"); } finally { onPending(false); }
  };
  const chooseDomain = async (index: number, value: string) => {
    if (value !== NEW_DOMAIN) return editor.setDomain(index, value);
    const name = await askText("新しい分野辞書", `分野辞書の名前（${MAX_DOMAIN_LENGTH}文字まで）`);
    if (name?.trim()) editor.setDomain(index, name.trim().slice(0, MAX_DOMAIN_LENGTH));
  };
  const move = (indexes: ReadonlySet<number>, name: string) => {
    try { editor.moveTerms(indexes, name); setManagement({ selected: new Set() }); }
    catch (error) { showError(error, "用語を移動できませんでした"); }
  };
  const rename = async () => {
    if (!domainFilter) return;
    const name = await askText("分野名を変更・統合", `「${domainFilter}」の移動先の名前（既存の名前なら統合します）`);
    if (!name?.trim() || name.trim().length > MAX_DOMAIN_LENGTH) return;
    const indexes = new Set(terms.flatMap((t, i) => domainNameOf(t) === domainFilter ? [i] : []));
    try { editor.moveTerms(indexes, name.trim()); editor.setDomainFilter(name.trim()); setManagement({ selected: new Set() }); }
    catch (error) { showError(error, "分野名を変更できませんでした"); }
  };
  const addRow = () => {
    editor.addRow();
    setManagement({ selected: new Set() });
    requestAnimationFrame(() => {
      const inputs = rowsRef.current?.querySelectorAll<HTMLInputElement>('input[aria-label^="原語 "]');
      inputs?.[inputs.length - 1]?.focus();
    });
  };
  return <section aria-label="辞書全体の管理" className="space-y-3 text-[0.8125rem]">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="font-medium">{`辞書全体（${terms.length}件）`}</h3>
        <p className="text-muted-foreground mt-1">ほかの論文でも使う訳語を登録します。保存後、次の翻訳から反映します。</p></div>
      <Button variant="outline" disabled={busy || !editor.saved} onClick={addRow}>手動で用語を追加</Button>
    </div>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">使う分野について</summary><p className="mt-1">同じ原語に分野ごとの訳語を登録できます。分野を指定した語は論文の文脈に合うものを適用し、「共通」の語は全分野の論文で使います。</p></details>
    <fieldset disabled={busy} className="min-w-0">
    <div className="flex flex-wrap gap-2 mb-3">
      <div className="flex flex-1 min-w-48 gap-1">
      <Input ref={searchRef} aria-label="辞書を検索" placeholder="原語・日本語訳を検索" value={search} onChange={e => editor.setSearch(e.target.value)} />
      {search && <Button variant="ghost" aria-label="辞書の検索語を消す" onClick={() => { editor.setSearch(""); searchRef.current?.focus(); }}>解除</Button>}
      </div>
      <NativeSelect aria-label="分野で絞り込み" className="w-44 max-w-full" value={domainFilter ?? ""} onChange={e => editor.setDomainFilter(e.target.value || null)}>
        <option value="">すべての分野</option>
        <option value={GENERAL_DOMAIN}>共通（全分野）</option>
        {domainNames.map((name) => <option key={name} value={name}>{name}</option>)}
        {domainFilter && domainFilter !== GENERAL_DOMAIN && !domainNames.includes(domainFilter) && <option value={domainFilter}>{domainFilter}</option>}
      </NativeSelect>
      <NativeSelect aria-label="辞書の表示" className="w-32" value={view} onChange={(e) => editor.setView(e.target.value as GlossaryView)}>
        <option value="all">すべての語</option><option value="new">今回の追加</option><option value="existing">登録済み</option>
      </NativeSelect>
    </div>
    <div className="flex flex-wrap justify-between gap-2 mb-2">
    <label className="flex items-center gap-2"><input type="checkbox" disabled={!shown.length}
      checked={shown.length > 0 && shown.every(({ index }) => selected.has(index))}
      onChange={(e) => setManagement({ selected: e.target.checked ? new Set(shown.map(({ index }) => index)) : new Set() })} />表示中の語を選択</label>
    <span className="text-muted-foreground" role="status">{shown.length} / {terms.length}件{editor.dirty ? "・未保存の変更あり" : ""}</span>
    </div>
    <div ref={rowsRef} className="space-y-2">
      {!shown.length && <p role="status" className="py-2 text-muted-foreground">{terms.length ? "条件に一致する用語はありません。検索語や絞り込みを変えてください。" : "辞書は空です。「手動で用語を追加」から登録できます。"}</p>}
      {shown.map(({ item, index }) => <div key={index} className="rounded-lg border p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
        <input type="checkbox" aria-label={`${item.source || index + 1}を移動対象に選択`} checked={selected.has(index)} onChange={(e) => {
          const next = new Set(selected); if (e.target.checked) next.add(index); else next.delete(index); setManagement({ selected: next });
        }} />
        {newSources.has(item.source) && <span className="text-primary shrink-0">新規</span>}
        <span className="text-xs text-muted-foreground">使う分野</span>
        <NativeSelect aria-label={`分野 ${index + 1}`} className="flex-1 min-w-0 max-w-80" value={item.domain?.trim() || GENERAL_DOMAIN}
          onChange={e => void chooseDomain(index, e.target.value)}>
          <option value={GENERAL_DOMAIN}>共通（全分野）</option>
          {domainNames.map((name) => <option key={name} value={name}>{name}</option>)}
          <option value={NEW_DOMAIN}>新しい分野…</option>
        </NativeSelect>
        <Button variant="ghost" className="ml-auto" aria-label={`${item.source || `用語 ${index + 1}`}を辞書から削除`} onClick={() => { editor.removeTerm(index); setManagement({ selected: new Set() }); }}>削除</Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1"><span className="text-xs text-muted-foreground">原語</span>
            <Input aria-label={`原語 ${index + 1}`} placeholder="例: motion primitive" value={item.source} onChange={e => editor.setSource(index, e.target.value)} /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">日本語訳</span>
            <Input aria-label={`訳語 ${index + 1}`} placeholder="例: 基本動作" value={item.target} onChange={e => editor.setTarget(index, e.target.value)} /></label>
        </div>
      </div>)}
    </div>
    {selected.size > 0 && <div className="flex flex-wrap items-center gap-2 mt-2 rounded-lg bg-muted p-2">
      <span>{selected.size}語を</span><NativeSelect aria-label="まとめて移動する分野" value={destination} onChange={(e) => setManagement({ destination: e.target.value })}>
        {[GENERAL_DOMAIN, ...domainNames].map((name) => <option key={name} value={name}>{name}</option>)}<option value={NEW_DOMAIN}>新しい分野…</option>
      </NativeSelect><Button variant="outline" onClick={async () => {
        const name = destination === NEW_DOMAIN ? await askText("移動先の分野", `分野名（${MAX_DOMAIN_LENGTH}文字まで）`) : destination;
        if (name?.trim() && name.trim().length <= MAX_DOMAIN_LENGTH) move(selected, name.trim());
      }}>移動</Button>
      <Button variant="ghost" onClick={() => setManagement({ selected: new Set() })}>選択を解除</Button>
    </div>}
    <div className="flex gap-2 mt-2">
      {!saveInFooter && <Button disabled={!editor.dirty || busy} onClick={() => void save()}>辞書を保存</Button>}
      {editor.canUndo && <Button variant="outline" onClick={() => { editor.undo(); setManagement({ selected: new Set() }); }}>直前の編集を戻す</Button>}
    </div>
    <details className="mt-3 border-t pt-2"><summary className="cursor-pointer">分野の整理</summary>
      <Button variant="outline" className="my-2" disabled={!domainFilter || domainFilter === GENERAL_DOMAIN} onClick={() => void rename()}>表示中の分野を改名・統合</Button>
      <div className="flex flex-wrap items-center gap-2 my-2">
        <NativeSelect aria-label="分ける辞書" className="w-44" value={splitTarget} onChange={e => setManagement({ splitChoice: e.target.value })}>
          {splitNames.map((name) => <option key={name} value={name}>{name}（{counts[name] ?? 0}語）</option>)}
        </NativeSelect>
        <Button variant="outline" disabled={!domains.canSplit || editor.dirty || !counts[splitTarget]} onClick={() => domains.onSplit(splitTarget)}>AIで細かい分野に分ける</Button>
      </div>
      <p className="text-muted-foreground">自動運転・建設機械・土工など、訳語の意味が異なる分野に分ける案を作ります。確認して「辞書を保存」で適用します（利用枠を使います）。</p>
    </details>
    </fieldset>
    <details className="mt-3 border-t pt-2"><summary className="cursor-pointer">辞書ファイルの読み込み・書き出し</summary>
      <GlossaryTransfer key={transferKey} terms={terms} disabled={busy || !editor.saved}
        onPending={onPending} onImport={(list, added) => { editor.addCandidates(list, added); setManagement({ selected: new Set() }); }} />
    </details>
  </section>;
}
