import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { showError } from "@/components/errorDialog";
import { fetchGlossary, useSaveGlossary } from "@/api/mutations";
import { QK } from "@/lib/queryKeys";
import { useSessionState } from "@/lib/useSessionState";
import { GlossaryTransfer } from "./GlossaryTransfer";
import { normalizeTerms, type Term } from "./translationStart";

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
  expanded: boolean;
};

const initialState = (): EditorState => ({ edits: null, base: [], newSources: new Set(), search: "", view: "all", expanded: false });

/**
 * The common glossary as the translation dialog edits it: the saved glossary (GET /api/glossary) until
 * the user changes it, then the edited list, until it is saved. Started over each time the dialog opens
 * (`session`: the paper's id while it is open, else null).
 */
export function useGlossaryEditor(session: string | null) {
  const { data: saved } = useQuery({ queryKey: [QK.glossary], queryFn: fetchGlossary, enabled: session !== null });
  const [state, update] = useSessionState(session, initialState);
  const saveGlossary = useSaveGlossary();
  const terms = state.edits ?? saved ?? [];
  const dirty = state.edits !== null;
  const edit = (change: (terms: Term[]) => Term[], more: (state: EditorState) => Partial<EditorState> = () => ({})) =>
    update((s) => ({ ...more(s), edits: change(s.edits ?? saved ?? []), base: s.edits ? s.base : saved ?? [] }));
  return {
    /** The saved glossary; undefined until it has loaded. */
    saved,
    terms,
    dirty,
    newSources: state.newSources,
    search: state.search,
    view: state.view,
    expanded: state.expanded,
    setSearch: (search: string) => update({ search }),
    setView: (view: GlossaryView) => update({ view }),
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
    removeTerm: (index: number) => edit((list) => list.filter((_, i) => i !== index)),
    addRow: () => edit((list) => [...list, { source: "", target: "" }],
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

/** The glossary section of the translation dialog: the AI's check for unregistered terms, the list, and its file import and export. */
export function GlossaryEditor({ editor, transferKey, busy, generating, canGenerate, onGenerate, onPending }: {
  editor: GlossaryEditorState;
  /** Starts the file import and export over (its messages) with each opening. */
  transferKey: string;
  busy: boolean;
  generating: boolean;
  canGenerate: boolean;
  onGenerate: () => void;
  /** A save or a file import or export under way, which holds the dialog. */
  onPending: (pending: boolean) => void;
}) {
  const { terms, newSources, view, search } = editor;
  const shown = terms.map((item, index) => ({ item, index })).filter(({ item }) =>
    (view === "all" || newSources.has(item.source) === (view === "new")) &&
    `${item.source} ${item.target}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const save = async () => {
    onPending(true);
    try { await editor.save(); } catch (error) { showError(error, "辞書を保存できませんでした"); } finally { onPending(false); }
  };
  return <details className="border rounded p-2 text-[0.75rem]" open={editor.expanded} onToggle={e => editor.setExpanded(e.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">全論文共通の専門用語辞書（{terms.length}件）</summary>
    <p className="text-muted-foreground my-2">用語を確認すると、翻訳前にAIがこの論文から共通辞書にない専門用語のうち、訳語が定まっていない語や訳し方に迷う語だけを日本語訳の案と一緒に抽出します。「モデル予測制御」のように訳語が一つに決まる語は候補に含めません。候補を確認・修正して追加すると、今後のすべての論文で使えます。過去の登録語もここで確認・修正できます。辞書の変更は各論文を次に翻訳するときに反映されます。</p>
    <fieldset disabled={busy} className="min-w-0">
    <Button onClick={onGenerate} disabled={!canGenerate}>
      {generating ? "AIが対応表を作成中…" : "AIで未登録の専門用語を確認"}
    </Button>
    <p className="text-muted-foreground my-2">{terms.length ? "過去の登録語を含む共通辞書です。今回の追加候補には「新規」と表示します。" : "上で選択したモデルを使用します。生成した対応表は保存するまで翻訳に適用されません。"}</p>
    <div className="flex gap-1 my-2">
      <Button variant={view === "new" ? "default" : "outline"} onClick={() => editor.setView("new")}>今回の追加候補</Button>
      <Button variant={view === "existing" ? "default" : "outline"} onClick={() => editor.setView("existing")}>過去の登録語</Button>
      <Button variant={view === "all" ? "default" : "outline"} onClick={() => editor.setView("all")}>すべて</Button>
    </div>
    <Input aria-label="共通辞書を検索" placeholder="原語・日本語訳を検索" value={search} onChange={e => editor.setSearch(e.target.value)} className="mb-2" />
    <div className="grid grid-cols-[1fr_1fr_auto] gap-1 mb-1"><span>原語</span><span>日本語訳</span><span className="w-12" /></div>
    <div className="max-h-60 overflow-auto space-y-1">
      {shown.map(({ item, index }) => <div key={index} className="flex items-center gap-1">
        {newSources.has(item.source) && <span className="text-primary shrink-0">新規</span>}
        <Input aria-label={`原語 ${index + 1}`} placeholder="原語" value={item.source} onChange={e => editor.setSource(index, e.target.value)} />
        <Input aria-label={`訳語 ${index + 1}`} placeholder="訳語" value={item.target} onChange={e => editor.setTarget(index, e.target.value)} />
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
