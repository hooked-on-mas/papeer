import { useEffect, useId, useMemo, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Copy, Undo2 } from "lucide-react";
import type { PaperData } from "@/api/hooks";
import { copyBibtex } from "@/app/actions";
import { Input } from "@/components/ui/input";
import { flushDraft, hideDraft, revertField, showDraft, typeField, useMetadataDraft } from "./metadataAutosave";
import { metaValues, unsavedFields, type MetaField } from "./paperMetadata";
import { isImeKey } from "@/lib/imeKeys";
import { ReadingOrganization } from "./ReadingOrganization";

const FIELDS: { field: MetaField; label: string; placeholder: string; maxLength?: number; spellCheck?: boolean }[] = [
  { field: "title", label: "タイトル", placeholder: "" },
  { field: "author", label: "筆頭著者", placeholder: "例：Smith / 山田太郎" },
  { field: "year", label: "出版年", placeholder: "例：2024（不明なら空欄）", maxLength: 4 },
  { field: "venue", label: "掲載誌", placeholder: "例：IEEE Transactions on …（会議名も可）", maxLength: 300 },
  { field: "doi", label: "DOI", placeholder: "例：10.1000/xyz123", maxLength: 500, spellCheck: false },
  { field: "arxiv_id", label: "arXiv ID", placeholder: "例：2101.00001", maxLength: 200, spellCheck: false },
];

/**
 * 論文情報: saved as it is typed (metadataAutosave.ts), without a button. A value that cannot be saved
 * says why under its field once the field is left (not while it is typed), with a button that puts the
 * saved value back; it stays, unsaved, while other tabs or papers are shown, and closing the app asks
 * whether to close without it.
 */
export function PaperMetadataForm({ paper, collections }: { paper: PaperData; collections: string[] }) {
  const paperId = paper.id;
  const server = useMemo(() => metaValues(paper), [paper]);
  const draft = useMetadataDraft(paperId);
  const [focused, setFocused] = useState<MetaField | null>(null);
  const id = useId();

  useEffect(() => showDraft(paperId, server), [paperId, server]);
  useEffect(() => () => void hideDraft(paperId).catch(() => undefined), [paperId]);

  const values = draft?.values ?? server;
  const unsaved = draft ? unsavedFields(draft) : [];
  const problems = draft?.problems ?? {};
  const hasProblem = unsaved.some((field) => problems[field]);
  const state = draft?.saving ? "保存中…" : draft?.failure ? "保存できませんでした" : hasProblem ? "保存できない項目があります"
    : unsaved.length ? "未保存" : "自動保存済み ✓";

  const input = (field: MetaField, props: { placeholder: string; maxLength?: number; spellCheck?: boolean; list?: string }) => {
    // Why it was not saved, once the field is left; said once by screen readers as it appears.
    const problem = unsaved.includes(field) && focused !== field ? problems[field] : undefined;
    const problemId = `${id}-${field}-problem`;
    const control = {
      id: `${id}-${field}`,
      value: values[field],
      placeholder: props.placeholder,
      maxLength: props.maxLength,
      spellCheck: props.spellCheck,
      "aria-invalid": problem ? true as const : undefined,
      "aria-describedby": problem ? problemId : undefined,
      onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => typeField(paperId, field, e.target.value),
      onFocus: () => setFocused(field),
      onBlur: () => { setFocused(null); void flushDraft(paperId); },
      onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !isImeKey(e.nativeEvent)) {
          e.preventDefault();
          void flushDraft(paperId);
        }
      },
    };
    return <>
      {field === "title" ? <textarea {...control} rows={3}
        className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive" />
        : <Input {...control} list={props.list} />}
      {problem && <div id={problemId} role="alert" className="col-start-2 flex items-start gap-2 text-[0.75rem] text-destructive">
        <span className="min-w-0 flex-1">{problem}</span>
        <button type="button" onClick={() => revertField(paperId, field)}
          className="flex shrink-0 items-center gap-1 rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <Undo2 className="size-3" aria-hidden="true" />元に戻す
        </button>
      </div>}
    </>;
  };

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <ReadingOrganization paper={paper} />
        <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-2 gap-y-2 text-[0.8125rem]">
          <label htmlFor={`${id}-collection`}>フォルダー</label>
          {input("collection", { placeholder: "例：制御工学 / 読書会", list: `${id}-collections` })}
          <datalist id={`${id}-collections`}>
            {collections.map((c) => <option key={c} value={c} />)}
          </datalist>
          {!!values.collection && <button type="button" className="col-start-2 justify-self-start rounded px-1 py-0.5 text-[0.75rem] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => { typeField(paperId, "collection", ""); void flushDraft(paperId); }}>
            未分類に戻す
          </button>}
          <details className="col-start-2 text-[0.75rem] text-muted-foreground">
            <summary className="cursor-pointer">フォルダーの入力方法</summary>
            <p className="mt-1">「/」で区切るとサブフォルダーになります。欄を離れるか Enter で移動し、空欄にすると未分類になります。</p>
          </details>
        </div>
      </section>
      <section className="space-y-3 border-t pt-3">
        <h3 className="text-[0.8125rem] font-semibold">論文情報 <span className="font-normal text-muted-foreground text-[0.75rem]">入力後に自動保存します。</span></h3>
        <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-2 gap-y-2 text-[0.8125rem]">
          {FIELDS.map(({ field, label, ...props }) => (
            <div key={field} className="contents">
              <label htmlFor={`${id}-${field}`}>{label}</label>
              {input(field, props)}
            </div>
          ))}
          <details className="col-span-2 text-[0.75rem] text-muted-foreground">
            <summary className="cursor-pointer">論文情報の取得について</summary>
            <p className="mt-1">論文情報は追加時にPDFから読み取ります。設定の「論文情報の取得にAIを使う」がONの場合は、不足情報をAIと外部の書誌情報サービスで補完します。BibTeXに使います。</p>
          </details>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={`text-[0.75rem] ${hasProblem || draft?.failure ? "text-destructive" : "text-muted-foreground"}`}
            title={draft?.failure || undefined}>{state}</span>
          <button
            type="button"
            onClick={() => void copyBibtex([paperId], flushDraft(paperId))}
            disabled={hasProblem}
            title={hasProblem ? "保存できない項目を直すか元に戻すとコピーできます" : undefined}
            className="flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Copy className="w-4 h-4" aria-hidden="true" /> BibTeX をコピー
          </button>
        </div>
      </section>
    </div>
  );
}
