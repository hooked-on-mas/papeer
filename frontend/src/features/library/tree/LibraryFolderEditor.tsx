import { useMemo } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { NativeSelect } from '../../../components/ui/native-select';
import type { Folder } from '../../../runtime/edits/contracts';
import { canonicalLibraryRows, canonicalFolderKey } from './canonicalLibraryTree';

export type LibraryFolderDraft = { mode: 'create' | 'rename' | 'move-folder' | 'move-items' | 'remove';
  id?: string; ids?: string[]; title: string; expectedTitle?: string; parentId: string | null };

export function LibraryFolderEditor({ draft, folders, targetsAvailable = true, busy, canApply, change, save, cancel }: {
  draft: LibraryFolderDraft; folders: readonly Folder[]; targetsAvailable?: boolean; busy: boolean; canApply: boolean;
  change(update: (draft: LibraryFolderDraft) => LibraryFolderDraft): void; save(): void; cancel(): void;
}) {
  const naming = draft.mode === 'create' || draft.mode === 'rename', moving = draft.mode === 'move-folder' || draft.mode === 'move-items';
  const needsParent = draft.mode === 'create' || moving;
  const byId = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders]);
  const ordered = useMemo(() => canonicalLibraryRows({ items: [], folders, expanded: new Set(folders.map(folder => canonicalFolderKey(folder.id))) })
    .map(row => byId.get(row.id)!), [folders, byId]);
  const forbidden = useMemo(() => {
    const result = new Set<string>(); if (draft.mode !== 'move-folder' || !draft.id) return result;
    const children = new Map<string, string[]>();
    for (const folder of folders) if (folder.parentId) { const list = children.get(folder.parentId) ?? []; list.push(folder.id); children.set(folder.parentId, list); }
    const pending = [draft.id];
    while (pending.length) { const id = pending.pop()!; if (result.has(id)) continue; result.add(id); for (const child of children.get(id) ?? []) pending.push(child); }
    return result;
  }, [draft.mode, draft.id, folders]);
  const parentValid = !needsParent || draft.parentId === null || (byId.has(draft.parentId) && !forbidden.has(draft.parentId));
  const valid = targetsAvailable && parentValid;
  const path = (folder: Folder) => {
    const labels = [folder.title], seen = new Set([folder.id]); let parent = folder.parentId;
    while (parent && !seen.has(parent) && labels.length < 3) { seen.add(parent); const value = byId.get(parent); if (!value) break; labels.unshift(value.title); parent = value.parentId; }
    return `${parent ? '… / ' : ''}${labels.join(' / ')}`;
  };
  return <form aria-label="フォルダーの操作" className="space-y-4 text-sm" onSubmit={event => {
    event.preventDefault(); if (canApply && !busy && valid) save();
  }}>
    {naming && <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">フォルダー名</span>
      <Input aria-label="フォルダー名" autoFocus value={draft.title} disabled={busy}
        onChange={event => { const title = event.currentTarget.value; change(current => ({ ...current, title })); }} />
    </label>}
    {needsParent && <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{moving ? '移動先のフォルダー' : '親フォルダー'}</span>
      <NativeSelect aria-label={moving ? '移動先のフォルダー' : '親フォルダー'} value={draft.parentId ?? ''} disabled={busy}
        onChange={event => { const parentId = event.currentTarget.value || null; change(current => ({ ...current, parentId })); }}>
        <option value="">未分類</option>
        {!parentValid && <option value={draft.parentId ?? ''} disabled>利用できないフォルダー</option>}
        {ordered.map(folder => <option key={folder.id} value={folder.id} disabled={forbidden.has(folder.id)}>{path(folder)}</option>)}
      </NativeSelect>
    </label>}
    {draft.mode === 'remove' && <p className="text-sm text-muted-foreground">「{draft.title}」のフォルダーだけを削除し、直下の資料と子フォルダーを親へ移動します。子孫の構成と本文は保持します。</p>}
    {draft.mode === 'move-items' && <p className="text-sm text-muted-foreground">{draft.ids?.length ?? 0}件の資料を移動します。</p>}
    {!valid && <p role="alert" className="text-xs text-destructive">移動先や対象のフォルダー・資料を確認してください。入力は保持しています。</p>}
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="outline" disabled={busy} onClick={cancel}>フォルダー操作を取り消す</Button>
      <Button type="submit" variant={draft.mode === 'remove' ? 'destructive' : 'default'} disabled={busy || !canApply || !valid || naming && !draft.title.trim()}>
        {naming ? 'フォルダーを保存' : moving ? '移動する' : '内容を残して削除'}
      </Button>
    </div>
  </form>;
}
