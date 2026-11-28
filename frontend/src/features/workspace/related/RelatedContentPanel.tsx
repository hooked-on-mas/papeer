import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Columns2, FileText, NotebookPen, Paperclip, X } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import type { LibraryScopeBinding } from '../../reader/DocumentLibraryBinding';
import type { ContentNavigationSession } from '../../reader/navigation/ContentNavigationSession';
import { useWorkspaceCommands, useWorkspaceFocusBlocker } from '../WorkspaceCommandContext';
import { projectRelatedContent } from './relatedContent';

export function RelatedContentPanel({ binding, navigation }: { binding: LibraryScopeBinding; navigation: ContentNavigationSession }) {
  const commands = useWorkspaceCommands(), library = binding.sessions.getLibrary();
  const catalog = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const selected = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const registry = useSyncExternalStore(binding.sessions.subscribe, binding.sessions.getSnapshot, binding.sessions.getSnapshot);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef(false), lifetime = useRef(0), identity = useRef<object>({});
  useWorkspaceFocusBlocker(() => !pending.current);
  useLayoutEffect(() => {
    if (!commands) return;
    const current = ++lifetime.current, token = identity.current;
    const release = commands.registerRelatedPanelGuard(token, () => !pending.current);
    const retire = () => { if (lifetime.current === current) lifetime.current++; };
    return () => { retire(); release(); };
  }, [commands]);
  const projection = projectRelatedContent(catalog.ready && catalog.selectedVersion ? library.getSelectedSnapshot() : undefined, selected.documentId);
  const available = registry.ready && registry.active && !selected.busy && !!commands;
  const open = async (item: { id: string; kind: 'pdf' | 'notebook' | 'markdown' | 'attachment' }) => {
    if (!commands || !available || pending.current) return;
    const generation = lifetime.current, version = catalog.selectedVersion, sourceId = selected.documentId;
    let invalidated = false;
    const current = () => {
      if (lifetime.current !== generation || !binding.sessions.getSnapshot().active || library.getSnapshot().selectedVersion !== version
        || navigation.getSnapshot().documentId !== sourceId) invalidated = true;
      return !invalidated;
    };
    const releases = [navigation.subscribe(current), library.subscribe(current), binding.sessions.subscribe(current)];
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await commands.openContent(item, catalog.heads.length > 1 ? version ?? undefined : undefined);
      if (result.status === 'blocked' && current())
        setError('資料を開けません。入力と保存状態を確認してください。');
    } catch {
      if (current()) setError('資料を開けません。入力と保存状態を確認してください。');
    } finally { releases.forEach(release => release()); pending.current = false; if (lifetime.current === generation) setBusy(false); }
  };
  const moveCenter = async (item: { id: string; kind: 'pdf' | 'notebook' | 'markdown' | 'attachment' }) => {
    if (!commands || !available || pending.current) return;
    const generation = lifetime.current;
    let invalidated = false;
    const current = () => {
      if (lifetime.current !== generation || !binding.sessions.getSnapshot().active || navigation.getSnapshot().documentId !== item.id) invalidated = true;
      return !invalidated;
    };
    const releases = [navigation.subscribe(current), binding.sessions.subscribe(current)];
    pending.current = true; setBusy(true); setError('');
    try {
      const ok = await commands.moveEditor(item, 'center');
      if (!ok && current()) setError('編集面を移動できません。');
    } catch {
      if (current()) setError('編集面を移動できません。');
    } finally { releases.forEach(release => release()); pending.current = false; if (lifetime.current === generation) setBusy(false); }
  };
  return <section aria-label="付属ノート・添付" className="flex h-full min-h-0 min-w-0 flex-col border-l bg-background">
    <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
      <h2 className="truncate text-xs font-semibold text-foreground">付属ノート・添付</h2>
      {commands && (
        <Button type="button" variant="ghost" size="icon-xs" aria-label="付属ノート・添付パネルを閉じる" title="閉じる"
          onClick={() => { commands.setRelatedPanelOpen(false); }}>
          <X className="size-3.5" />
        </Button>
      )}
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-2.5 text-xs">
      {projection.status === 'unavailable' ? <p role="status" className="text-muted-foreground">付属ノート・添付を確認できません。</p>
        : projection.items.length === 0 ? <p className="text-muted-foreground">付属ノート・添付はありません。</p>
        : <ul className="min-w-0 space-y-1.5">
          {projection.items.map(item => {
            const Icon = item.kind === 'attachment' ? Paperclip : item.kind === 'notebook' ? NotebookPen : FileText;
            const kindLabel = item.kind === 'attachment' ? '添付' : item.kind === 'notebook' ? '手書きノート' : 'Markdown';
            const isCurrent = selected.documentId === item.id;
            return <li key={item.id} className={`min-w-0 rounded-md border p-1.5 ${isCurrent ? 'border-primary bg-accent/40' : 'bg-card'}`}>
              <button type="button"
                className="flex w-full min-w-0 items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-muted disabled:opacity-50"
                disabled={!available || busy} onClick={() => { void open(item); }}>
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 break-words">
                  <span className="text-muted-foreground">{kindLabel}: </span>
                  <span className="font-medium text-foreground">{item.title}</span>
                </span>
              </button>
              {isCurrent && item.kind !== 'attachment' && (
                <Button type="button" variant="outline" size="xs" className="mt-1.5 w-full" disabled={!available || busy}
                  onClick={() => { void moveCenter(item); }}>
                  <Columns2 className="size-3" />中央で編集
                </Button>
              )}
            </li>;
          })}
        </ul>}
      {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    </div>
  </section>;
}
