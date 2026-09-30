import { useState } from "react";
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
import { checkedDomains, countDomainTerms, domainNamesIn, inDomainFilter, toggledChoice, withDomain, type PaperDomains } from "./glossaryDomains";
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
};

const initialState = (): EditorState => ({ edits: null, base: [], newSources: new Set(), search: "", view: "all", domainFilter: null, expanded: false });

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
    update((s) => ({ ...more(s), edits: change(s.edits ?? saved ?? []), base: s.edits ? s.base : saved ?? [] }));
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
      update({ edits: null });
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
};

/** How the AI's choice (or the user's) is described under the check boxes. */
function choiceNote(record: PaperDomains): string {
  if (record.chosen_by === "ai") return "AIがこの論文の内容から選びました。チェックで変更できます（変更すると、以降はAIによる選び直しをしません）。";
  if (record.chosen_by === "user") return "選択した分野辞書です。チェックで変更できます。";
  return "この論文にはまだ選択が記録されていないため、すべての分野辞書を使います。チェックで選べます。";
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
    <p className="text-muted-foreground">{choiceNote(record)}</p>
  </div>;
}

/** The glossary section of the translation dialog: the domains the paper uses, the AI's check for unregistered terms, the list, and its file import and export. */
export function GlossaryEditor({ editor, transferKey, busy, generating, canGenerate, onGenerate, onPending, domains }: {
  editor: GlossaryEditorState;
  /** Starts the file import and export over (its messages) with each opening. */
  transferKey: string;
  busy: boolean;
  generating: boolean;
  canGenerate: boolean;
  onGenerate: () => void;
  /** A save or a file import or export under way, which holds the dialog. */
  onPending: (pending: boolean) => void;
  domains: GlossaryDomainsControl;
}) {
  const { terms, newSources, view, search, domainFilter } = editor;
  const [splitChoice, setSplitChoice] = useState(GENERAL_DOMAIN);
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
  return <details className="border rounded p-2 text-[0.75rem]" open={editor.expanded} onToggle={e => editor.setExpanded(e.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">
      {domainNames.length ? `専門用語辞書（${terms.length}件・分野辞書 ${domainNames.length}）` : `全論文共通の専門用語辞書（${terms.length}件）`}
    </summary>
    <p className="text-muted-foreground my-2">用語を確認すると、翻訳前にAIがこの論文から辞書にない専門用語のうち、訳語が定まっていない語や訳し方に迷う語だけを日本語訳の案と一緒に抽出します。「モデル予測制御」のように訳語が一つに決まる語は候補に含めません。候補を確認・修正して追加すると、この論文の主な分野辞書（なければ共通）の語になります。共通の語はすべての論文で、分野辞書の語はそれを選んだ論文で使われます。過去の登録語もここで確認・修正できます。辞書の変更は各論文を次に翻訳するときに反映されます。</p>
    <fieldset disabled={busy} className="min-w-0">
    {domains.record && domains.record.available.length > 0 &&
      <DomainChoice record={domains.record} counts={counts} onChoose={domains.onChoose} />}
    <Button onClick={onGenerate} disabled={!canGenerate}>
      {generating ? "AIが対応表を作成中…" : "AIで未登録の専門用語を確認"}
    </Button>
    <p className="text-muted-foreground my-2">{terms.length ? "過去の登録語を含む辞書です。今回の追加候補には「新規」と表示します。" : "上で選択したモデルを使用します。生成した対応表は保存するまで翻訳に適用されません。"}</p>
    <div className="flex items-center gap-1 my-2">
      <NativeSelect aria-label="分ける辞書" className="w-44" value={splitTarget} onChange={e => setSplitChoice(e.target.value)}>
        {splitNames.map((name) => <option key={name} value={name}>{name}（{counts[name] ?? 0}語）</option>)}
      </NativeSelect>
      <Button variant="outline" disabled={!domains.canSplit || editor.dirty || !counts[splitTarget]} onClick={() => domains.onSplit(splitTarget)}>
        AIで分野ごとに分ける
      </Button>
    </div>
    <p className="text-muted-foreground mb-2">{editor.dirty
      ? "保存していない編集があります。「辞書を保存」してから分けられます。"
      : "選んだ辞書の語を、AIが分野ごとの分野辞書に分けます。語の並びは変わらず、訳の再利用にも影響しません（利用枠を使います）。"}</p>
    <div className="flex gap-1 my-2">
      <Button variant={view === "new" ? "default" : "outline"} onClick={() => editor.setView("new")}>今回の追加候補</Button>
      <Button variant={view === "existing" ? "default" : "outline"} onClick={() => editor.setView("existing")}>過去の登録語</Button>
      <Button variant={view === "all" ? "default" : "outline"} onClick={() => editor.setView("all")}>すべて</Button>
    </div>
    <div className="flex gap-1 mb-2">
      <Input aria-label="辞書を検索" placeholder="原語・日本語訳を検索" value={search} onChange={e => editor.setSearch(e.target.value)} />
      <NativeSelect aria-label="分野で絞り込み" className="w-40 shrink-0" value={domainFilter ?? ""} onChange={e => editor.setDomainFilter(e.target.value || null)}>
        <option value="">すべての分野</option>
        <option value={GENERAL_DOMAIN}>{GENERAL_DOMAIN}</option>
        {domainNames.map((name) => <option key={name} value={name}>{name}</option>)}
        {domainFilter && domainFilter !== GENERAL_DOMAIN && !domainNames.includes(domainFilter) && <option value={domainFilter}>{domainFilter}</option>}
      </NativeSelect>
    </div>
    <div className="grid grid-cols-[1fr_1fr_7rem_auto] gap-1 mb-1"><span>原語</span><span>日本語訳</span><span>分野</span><span className="w-12" /></div>
    <div className="max-h-60 overflow-auto space-y-1">
      {shown.map(({ item, index }) => <div key={index} className="flex items-center gap-1">
        {newSources.has(item.source) && <span className="text-primary shrink-0">新規</span>}
        <Input aria-label={`原語 ${index + 1}`} placeholder="原語" value={item.source} onChange={e => editor.setSource(index, e.target.value)} />
        <Input aria-label={`訳語 ${index + 1}`} placeholder="訳語" value={item.target} onChange={e => editor.setTarget(index, e.target.value)} />
        <NativeSelect aria-label={`分野 ${index + 1}`} className="w-28 shrink-0" value={item.domain?.trim() || GENERAL_DOMAIN}
          onChange={e => void chooseDomain(index, e.target.value)}>
          <option value={GENERAL_DOMAIN}>{GENERAL_DOMAIN}</option>
          {domainNames.map((name) => <option key={name} value={name}>{name}</option>)}
          <option value={NEW_DOMAIN}>新しい分野…</option>
        </NativeSelect>
        <Button variant="outline" onClick={() => editor.removeTerm(index)}>削除</Button>
      </div>)}
    </div>
    <div className="flex gap-2 mt-2">
      <Button variant="outline" onClick={editor.addRow}>手動で用語を追加</Button>
      <Button variant="outline" disabled={!editor.dirty || busy} onClick={() => void save()}>辞書を保存</Button>
    </div>
    </fieldset>
    <GlossaryTransfer key={transferKey} terms={terms} disabled={busy || !editor.saved}
      onPending={onPending} onImport={(list, added) => editor.addCandidates(list, added)} />
  </details>;
}
