import { Button } from '../../../components/ui/button';
import { pyStrip } from '../../../lib/pyWhitespace';
import type { LibraryTagsUpdate } from '../canonicalLibraryOperations';

export type LibraryTagDraft = {
  ids: string[]; mode: 'add' | 'remove' | 'replace'; existing: string[];
  expectedTags: Record<string, string[]>;
  text: string; initialText: string; removing: string[];
};

/** A fixed target set and local input; the catalog authority validates and saves the operation. */
export function LibraryTagEditor({ draft, busy, canApply, targetsAvailable, apply, cancel, change }: {
  draft: LibraryTagDraft; busy: boolean; canApply: boolean; targetsAvailable: boolean;
  apply(input: LibraryTagsUpdate): Promise<boolean>; cancel(): void;
  change(update: (current: LibraryTagDraft) => LibraryTagDraft): void;
}) {
  const { text, initialText, removing } = draft;
  const lines = text.split(/\r?\n/).filter(value => pyStrip(value).length > 0);
  return <form aria-label="タグ編集" className="space-y-4 text-sm" onSubmit={event => {
    event.preventDefault();
    if (busy || !canApply || !targetsAvailable) return;
    const input: LibraryTagsUpdate = draft.mode === 'replace'
      ? { mode: 'replace', tags: text === initialText ? draft.expectedTags[draft.ids[0]] : lines, expectedTags: draft.expectedTags }
      : { mode: draft.mode, tags: draft.mode === 'remove' ? removing : lines };
    void apply(input);
  }}>
    <p className="text-muted-foreground">{draft.ids.length}件の資料のタグを{draft.mode === 'add' ? '追加します。' : draft.mode === 'remove' ? '削除します。' : '置き換えます。'}</p>
    {!targetsAvailable && <p role="alert" className="text-xs text-destructive">対象の資料が一覧にありません。入力は保持しています。対象を確認し直してください。</p>}
    {draft.mode === 'remove' ? <fieldset disabled={busy} className="space-y-2">
      <legend className="text-xs font-medium text-muted-foreground">削除するタグ</legend>
      <div className="flex flex-wrap gap-2">
        {draft.existing.map(tag => <label key={tag} className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
          <input type="checkbox" aria-label={`削除するタグ「${tag}」`} checked={removing.includes(tag)}
            onChange={event => { const checked = event.currentTarget.checked;
              change(current => ({ ...current, removing: checked ? current.removing.includes(tag) ? current.removing : [...current.removing, tag]
                : current.removing.filter(value => value !== tag) })); }} />{tag}
        </label>)}
      </div>
      {!draft.existing.length && <p className="text-xs text-muted-foreground">削除できるタグはありません。</p>}
    </fieldset> : <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">タグ（1行に1つ）</span>
      <textarea aria-label="タグ（1行に1つ）" autoFocus rows={4} value={text} disabled={busy}
        className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        onChange={event => {
          const text = event.currentTarget.value; change(current => ({ ...current, text }));
        }} />
    </label>}
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="outline" disabled={busy} onClick={cancel}>タグ編集を取り消す</Button>
      <Button type="submit" disabled={busy || !canApply || !targetsAvailable || (draft.mode === 'remove' ? !removing.length : draft.mode === 'add' && !lines.length)}>タグを適用</Button>
    </div>
  </form>;
}
