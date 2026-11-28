import { Button } from '../../../components/ui/button';
import { NativeSelect } from '../../../components/ui/native-select';
import type { LibraryItem } from '../../../runtime/edits/contracts';
import type { LibraryDeleteMode } from '../canonicalLibraryOperations';

export type LibraryRelationDraft =
  | { mode: 'link'; sourceIds: string[]; targetId: string }
  | { mode: 'delete'; ids: string[]; childNotes: LibraryDeleteMode };

export function LibraryRelationEditor({ draft, items, busy, canApply, change, save, cancel }: {
  draft: LibraryRelationDraft; items: readonly LibraryItem[]; busy: boolean; canApply: boolean;
  change(update: (current: LibraryRelationDraft) => LibraryRelationDraft): void; save(): void; cancel(): void;
}) {
  const byId = new Map(items.map(item => [item.id, item]));
  if (draft.mode === 'link') {
    const sources = draft.sourceIds.map(id => byId.get(id)).filter((item): item is LibraryItem => !!item && !item.ownerId);
    const allPdf = sources.length === draft.sourceIds.length && sources.every(item => item.kind === 'pdf');
    const allNote = sources.length === draft.sourceIds.length && sources.length === 1
      && (sources[0].kind === 'markdown' || sources[0].kind === 'notebook');
    const sourcesAvailable = draft.sourceIds.length > 0 && (allPdf || allNote);
    const candidates = allPdf ? items.filter(item => !item.ownerId && (item.kind === 'markdown' || item.kind === 'notebook'))
      : allNote ? items.filter(item => !item.ownerId && item.kind === 'pdf') : [];
    const targetValid = !!draft.targetId && candidates.some(item => item.id === draft.targetId && !draft.sourceIds.includes(item.id));
    const valid = sourcesAvailable && targetValid;
    return <form className="space-y-4 text-sm"
      onSubmit={event => { event.preventDefault(); if (canApply && valid) save(); }}>
      <p className="text-muted-foreground">関連付け元: <span className="font-medium text-foreground">{sources.map(item => item.title).join('、') || `${draft.sourceIds.length}件`}</span></p>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">関連付ける資料</span>
        <NativeSelect aria-label="関連付ける資料" value={targetValid ? draft.targetId : ''} disabled={busy}
          onChange={event => change(current => current.mode === 'link' ? { ...current, targetId: event.target.value } : current)}>
          <option value="" disabled>関連付ける資料を選択</option>
          {candidates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </NativeSelect>
      </label>
      {(!sourcesAvailable || !targetValid) && <p role="alert" className="text-xs text-destructive">関連付けの対象を確認してください。入力は保持しています。</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" disabled={busy} onClick={cancel}>関連操作を取り消す</Button>
        <Button type="submit" disabled={!canApply || !valid}>関連を保存</Button>
      </div>
    </form>;
  }
  const targets = draft.ids.map(id => byId.get(id)).filter((item): item is LibraryItem => !!item);
  const targetsAvailable = draft.ids.length > 0 && targets.length === draft.ids.length;
  const targetSet = new Set(draft.ids);
  const ownedNotes = items.filter(item => item.ownerId && targetSet.has(item.ownerId) && !targetSet.has(item.id)
    && (item.kind === 'markdown' || item.kind === 'notebook'));
  return <form className="space-y-4 text-sm"
    onSubmit={event => { event.preventDefault(); if (canApply && targetsAvailable) save(); }}>
    <p className="text-muted-foreground">削除対象: <span className="font-medium text-foreground">{targets.map(item => item.title).join('、') || `${draft.ids.length}件`}</span></p>
    {ownedNotes.length > 0 && <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">子ノートの扱い</span>
      <NativeSelect aria-label="子ノートの扱い" value={draft.childNotes} disabled={busy}
        onChange={event => change(current => current.mode === 'delete' ? { ...current, childNotes: event.target.value as LibraryDeleteMode } : current)}>
        <option value="detach">子ノートを残して関連を解除</option>
        <option value="delete">内容も削除（子ノートも削除）</option>
      </NativeSelect>
    </label>}
    {!targetsAvailable && <p role="alert" className="text-xs text-destructive">削除対象を確認してください。入力は保持しています。</p>}
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="outline" disabled={busy} onClick={cancel}>削除を取り消す</Button>
      <Button type="submit" variant="destructive" disabled={!canApply || !targetsAvailable}>削除を確定</Button>
    </div>
  </form>;
}

