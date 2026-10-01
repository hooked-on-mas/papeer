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
      newSources: new Set([...s.newSources, ...added.map((t) => t.source)]), view: "new", search: "",
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
function DomainChoice({ record, counts, onChoose }: { record: PaperDomains; counts: Readonly<Record<string, number>>; onChoose: GlossaryDomainsControl["onChoose"] }) {
  const checked = checkedDomains(record);
  const missing = checked.filter((name) => !record.available.includes(name));
  const newDomain = record.new_domain && !record.available.includes(record.new_domain) ? record.new_domain : null;
  return <div className="border rounded p-2 my-2 space-y-1">
    <p className="font-medium">この論文に使う分野辞書</p>
    <label className="flex items-center gap-2"><input type="checkbox" checked disabled />共通（常に適用・{counts[GENERAL_DOMAIN] ?? 0}語）</label>
    {[...record.available, ...missing].map((name) => <label key={name} className="flex items-center gap-2">
      <input type="checkbox" checked={checked.includes(name)}
        onChange={(e) => { const next = toggledChoice(record, name, e.target.checked); onChoose(next.domains, next.newDomain); }} />
      <span>{name}（{missing.includes(name) ? "辞書にない" : `${counts[name] ?? 0}語`}）</span>
    </label>)}
    {newDomain && <label className="flex items-center gap-2">
      <input type="checkbox" checked onChange={() => onChoose(checked.filter((name) => record.available.includes(name)), null)} />
      <span>新しい分野「{newDomain}」をこの論文の用語に使う</span>
    </label>}
    <p className="text-muted-foreground">{choiceNote(record)} 選択した辞書の中でも、この論文の文脈に合う訳語だけを適用します。</p>
  </div>;
}

/** The glossary section of the translation dialog: the domains the paper uses, the AI's check for unregistered terms, the list, and its file import and export. */
export function GlossaryEditor({ editor, transferKey, busy, onPending, domains }: {
  editor: GlossaryEditorState;
  /** Starts the file import and export over (its messages) with each opening. */
  transferKey: string;
  busy: boolean;
  /** A save or a file import or export under way, which holds the dialog. */
  onPending: (pending: boolean) => void;
  domains: GlossaryDomainsControl;
}) {
  const { terms, newSources, view, search, domainFilter } = editor;
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
    `${item.source} ${item.target}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
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
  return <details className="border rounded p-2 text-[0.75rem]" open={editor.expanded} onToggle={e => editor.setExpanded(e.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">
      {`共用辞書を管理（${terms.length}件）`}
    </summary>
    <p className="text-muted-foreground my-2">今後も使いたい訳語を管理します。分野の語は論文の文脈に合うものだけを適用し、「共通」の語は全論文に適用します。変更は次の翻訳から反映されます。</p>
    <fieldset disabled={busy} className="min-w-0">
    {domains.record && domains.record.available.length > 0 &&
      <DomainChoice record={domains.record} counts={counts} onChoose={domains.onChoose} />}
    <NativeSelect aria-label="辞書の表示" className="my-2" value={view} onChange={(e) => editor.setView(e.target.value as GlossaryView)}>
      <option value="all">すべて</option><option value="new">今回の追加</option><option value="existing">登録済み</option>
    </NativeSelect>
    <div className="flex gap-1 mb-2">
      <Input aria-label="辞書を検索" placeholder="原語・日本語訳を検索" value={search} onChange={e => editor.setSearch(e.target.value)} />
      <NativeSelect aria-label="分野で絞り込み" className="w-40 shrink-0" value={domainFilter ?? ""} onChange={e => editor.setDomainFilter(e.target.value || null)}>
        <option value="">すべての分野</option>
        <option value={GENERAL_DOMAIN}>{GENERAL_DOMAIN}</option>
        {domainNames.map((name) => <option key={name} value={name}>{name}</option>)}
        {domainFilter && domainFilter !== GENERAL_DOMAIN && !domainNames.includes(domainFilter) && <option value={domainFilter}>{domainFilter}</option>}
      </NativeSelect>
    </div>
    <label className="flex items-center gap-2 mb-2"><input type="checkbox" disabled={!shown.length}
      checked={shown.length > 0 && shown.every(({ index }) => selected.has(index))}
      onChange={(e) => setManagement({ selected: e.target.checked ? new Set(shown.map(({ index }) => index)) : new Set() })} />表示中の語を選択</label>
    <div className="max-h-60 overflow-auto space-y-1">
      {shown.map(({ item, index }) => <div key={index} className="flex items-center gap-1">
        <input type="checkbox" aria-label={`${item.source || index + 1}を移動対象に選択`} checked={selected.has(index)} onChange={(e) => {
          const next = new Set(selected); if (e.target.checked) next.add(index); else next.delete(index); setManagement({ selected: next });
        }} />
        {newSources.has(item.source) && <span className="text-primary shrink-0">新規</span>}
        <Input aria-label={`原語 ${index + 1}`} placeholder="原語" value={item.source} onChange={e => editor.setSource(index, e.target.value)} />
        <Input aria-label={`訳語 ${index + 1}`} placeholder="訳語" value={item.target} onChange={e => editor.setTarget(index, e.target.value)} />
        <NativeSelect aria-label={`分野 ${index + 1}`} className="w-28 shrink-0" value={item.domain?.trim() || GENERAL_DOMAIN}
          onChange={e => void chooseDomain(index, e.target.value)}>
          <option value={GENERAL_DOMAIN}>{GENERAL_DOMAIN}</option>
          {domainNames.map((name) => <option key={name} value={name}>{name}</option>)}
          <option value={NEW_DOMAIN}>新しい分野…</option>
        </NativeSelect>
        <Button variant="outline" onClick={() => { editor.removeTerm(index); setManagement({ selected: new Set() }); }}>削除</Button>
      </div>)}
    </div>
    {selected.size > 0 && <div className="flex items-center gap-1 mt-2">
      <span>{selected.size}語を</span><NativeSelect aria-label="まとめて移動する分野" value={destination} onChange={(e) => setManagement({ destination: e.target.value })}>
        {[GENERAL_DOMAIN, ...domainNames].map((name) => <option key={name} value={name}>{name}</option>)}<option value={NEW_DOMAIN}>新しい分野…</option>
      </NativeSelect><Button variant="outline" onClick={async () => {
        const name = destination === NEW_DOMAIN ? await askText("移動先の分野", `分野名（${MAX_DOMAIN_LENGTH}文字まで）`) : destination;
        if (name?.trim() && name.trim().length <= MAX_DOMAIN_LENGTH) move(selected, name.trim());
      }}>移動</Button>
    </div>}
    <div className="flex gap-2 mt-2">
      <Button variant="outline" onClick={editor.addRow}>手動で用語を追加</Button>
      <Button variant="outline" disabled={!editor.dirty || busy} onClick={() => void save()}>辞書を保存</Button>
      {editor.canUndo && <Button variant="outline" onClick={() => { editor.undo(); setManagement({ selected: new Set() }); }}>直前の編集を戻す</Button>}
    </div>
    <details className="mt-3 border-t pt-2"><summary className="cursor-pointer">分類の整理</summary>
      {domains.onRefresh && <Button variant="outline" className="my-2" disabled={editor.dirty} onClick={domains.onRefresh}>この論文に適用する訳語を選び直す</Button>}
      <Button variant="outline" className="my-2" disabled={!domainFilter || domainFilter === GENERAL_DOMAIN} onClick={() => void rename()}>表示中の分野を改名・統合</Button>
      <div className="flex items-center gap-1 my-2">
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
  </details>;
}
