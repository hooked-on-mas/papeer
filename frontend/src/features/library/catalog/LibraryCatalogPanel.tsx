import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  FilePlus2, FolderPlus, MoreHorizontal, Paperclip, Plus, Redo2, RefreshCw, Search, SlidersHorizontal, Undo2, X,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { Input } from '../../../components/ui/input';
import { NativeSelect } from '../../../components/ui/native-select';
import { TagChip } from '../../../components/ui/TagChip';
import type { WorkspaceSelectionSession } from '../../workspace/WorkspaceSelectionSession';
import { useWorkspaceCommands, useWorkspaceFocusGuard } from '../../workspace/WorkspaceCommandContext';
import { FileChooserHold } from '../../workspace/FileChooserHold';
import type { LibraryScopeBinding } from '../../reader/DocumentLibraryBinding';
import type { ContentNavigationSession } from '../../reader/navigation/ContentNavigationSession';
import type { LibraryCreateInput } from '../LibrarySession';
import { LibraryChildRowView, LibraryFolderRowView, LibraryPaperRowView } from '../LibraryRows';
import { LibraryTagEditor, type LibraryTagDraft } from './LibraryTagEditor';
import { LibraryConflictPanel } from './LibraryConflictPanel';
import { LibraryFolderEditor, type LibraryFolderDraft } from '../tree/LibraryFolderEditor';
import { LibraryRelationEditor, type LibraryRelationDraft } from './LibraryRelationEditor';
import { LibraryBibliographyEditor, createBibliographyDraft, type LibraryBibliographyDraft } from './LibraryBibliographyEditor';
import { LibraryHierarchy } from '../tree/LibraryHierarchy';
import { canonicalLibraryRows, canonicalFolderKey, canonicalItemKey } from '../tree/canonicalLibraryTree';
import { reorderLibraryEntry } from '../tree/canonicalLibraryReorder';
import { canDropLibraryLinks, canLinkLibraryItems } from '../canonicalLibraryOperations';
import { createCanonicalLibraryCorpus, type LibraryPdfTextExtractor } from '../query/canonicalLibraryCorpus';
import type { LibraryQuery } from '../query/LibraryQuerySession';
import { DeletedContentComparisonConnection, type DeletedContentComparisonRequest } from '../recovery/DeletedContentComparisonConnection';

const readLibraryPdfText: LibraryPdfTextExtractor = async (...args) => (await import('../query/libraryPdfText')).readLibraryPdfText(...args);

/** The same catalog and creation authority surrounds both host-specific rendering adapters. */
export function LibraryCatalogPanel({ binding, navigation, selection, onItemOpen }: {
  binding: LibraryScopeBinding; navigation: ContentNavigationSession; selection?: WorkspaceSelectionSession | null; onItemOpen?: () => void;
}) {
  const library = useMemo(() => binding.sessions.getLibrary(), [binding.sessions]);
  const commands = useWorkspaceCommands();
  const state = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const display = useSyncExternalStore(library.query.subscribe, library.query.getSnapshot, library.query.getSnapshot);
  const corpus = useMemo(() => createCanonicalLibraryCorpus(binding.repository, readLibraryPdfText), [binding.repository]);
  useEffect(() => { library.query.setCorpus(corpus); }, [library, corpus]);
  const registry = useSyncExternalStore(binding.sessions.subscribe, binding.sessions.getSnapshot, binding.sessions.getSnapshot);
  const replication = useSyncExternalStore(binding.replication.subscribe, binding.replication.getSnapshot, binding.replication.getSnapshot);
  const selected = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const [createDraft, setCreateDraft] = useState<{ title: string; kind: LibraryCreateInput['kind'] } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(() => display.query.scope !== 'metadata' || display.query.tag !== ''
    || display.query.read !== 'all' || display.query.sort !== 'position' || display.query.descending);
  const [opening, setOpening] = useState(false);
  const [renaming, setRenaming] = useState<{ itemId: string; title: string; expectedTitle: string } | null>(null);
  const [checked, setChecked] = useState<string[]>([]), [tagDraft, setTagDraft] = useState<LibraryTagDraft | null>(null);
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const [focusedKey, setFocusedKey] = useState<string | null>(null), [focusRequest, setFocusRequest] = useState(0);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null), [folderDraft, setFolderDraft] = useState<LibraryFolderDraft | null>(null);
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null), [relationDraft, setRelationDraft] = useState<LibraryRelationDraft | null>(null);
  const [bibliographyDraft, setBibliographyDraft] = useState<LibraryBibliographyDraft | null>(null);
  const [comparison, setComparison] = useState<DeletedContentComparisonRequest | null>(null);
  const attachmentInput = useRef<HTMLInputElement>(null), attachmentOwner = useRef<string | null>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const chooser = useRef(new FileChooserHold());
  const cancelChooser = useCallback(() => {
    const token = chooser.current.current(); if (token) chooser.current.end(token); attachmentOwner.current = null;
  }, []);
  const attachPdf = useCallback((node: HTMLInputElement | null) => {
    pdfInput.current?.removeEventListener('cancel', cancelChooser); pdfInput.current = node;
    node?.addEventListener('cancel', cancelChooser);
  }, [cancelChooser]);
  const attachAttachment = useCallback((node: HTMLInputElement | null) => {
    attachmentInput.current?.removeEventListener('cancel', cancelChooser); attachmentInput.current = node;
    node?.addEventListener('cancel', cancelChooser);
  }, [cancelChooser]);
  useEffect(() => {
    const flight = chooser.current;
    const inputs = [attachmentInput.current, pdfInput.current];
    inputs.forEach(input => { input?.removeEventListener('cancel', cancelChooser); input?.addEventListener('cancel', cancelChooser); });
    return () => { flight.clear(); inputs.forEach(input => input?.removeEventListener('cancel', cancelChooser)); };
  }, [cancelChooser]);
  const chooseFile = (input: HTMLInputElement | null) => {
    if (!input) return;
    const token = chooser.current.begin(); if (!token) return;
    try { input.click(); } catch { chooser.current.end(token); }
  };
  const finishFile = (token: object) => chooser.current.end(token);
  const itemById = useMemo(() => new Map(state.items.map(item => [item.id, item])), [state.items]);
  const deletedItemById = useMemo(() => new Map(state.deletedItems.map(item => [item.id, item])), [state.deletedItems]);
  const deletedContentById = useMemo(() => new Map(state.deletedContent.map(entry => [entry.itemId, entry])), [state.deletedContent]);
  const folderById = useMemo(() => new Map(state.folders.map(folder => [folder.id, folder])), [state.folders]);
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of state.items) {
      if (!item.ownerId && item.folderId) counts.set(item.folderId, (counts.get(item.folderId) ?? 0) + 1);
    }
    return counts;
  }, [state.items]);
  const catalogIds = useMemo(() => new Set(state.items.map(item => item.id)), [state.items]);
  const rows = useMemo(() => display.flat ? display.ids.flatMap(id => {
    const item = itemById.get(id); return item ? [{ key: canonicalItemKey(id), id, kind: 'item' as const, depth: 0,
      parentKey: null, label: item.title, expandable: false, expanded: false }] : [];
  }) : canonicalLibraryRows({ items: state.items, folders: state.folders, links: state.links, expanded: openKeys }),
  [state.items, state.folders, state.links, openKeys, display.flat, display.ids, itemById]);
  const locationKeys = useMemo(() => {
    const item = selected.documentId ? itemById.get(selected.documentId) : undefined; if (!item) return '';
    const owner = item.ownerId ? itemById.get(item.ownerId) : undefined;
    const keys = owner ? [canonicalItemKey(owner.id)] : [], seen = new Set<string>(); let folderId = (owner ?? item).folderId;
    while (folderId && !seen.has(folderId)) { seen.add(folderId); keys.push(canonicalFolderKey(folderId)); folderId = folderById.get(folderId)?.parentId ?? null; }
    return keys.join('|');
  }, [selected.documentId, itemById, folderById]);
  const visibleIds = useMemo(() => new Set(rows.filter(row => row.kind === 'item').map(row => row.id)), [rows]);
  const checkedIds = checked.filter(id => visibleIds.has(id));
  const selectedFolder = state.folders.find(folder => folder.id === selectedFolderId);
  const selectionAttempted = useRef(false), selectionMounted = useRef(false);
  useLayoutEffect(() => { selectionMounted.current = true; return () => { selectionMounted.current = false; }; }, []);
  const [selectionRetry, setSelectionRetry] = useState(0);
  useEffect(() => {
    if (!selection || selectionAttempted.current || !registry.ready || !registry.active || !navigation.isAvailable() || !state.ready || state.heads.length !== 1 || !state.selectedVersion) return;
    selectionAttempted.current = true;
    const candidate = selection.candidate(); if (!candidate) return;
    const { value, generation } = candidate;
    const availability = navigation.getAvailabilityRevision();
    if (value.folderId && state.folders.some(folder => folder.id === value.folderId)) setSelectedFolderId(value.folderId);
    if (value.documentId && state.items.some(item => item.id === value.documentId) && navigation.getSnapshot().documentId === null)
      void navigation.restoreDocument(value.documentId, () => selection.isCurrent(generation)).then(result => {
        if (!selectionMounted.current) return;
        if (result.reason === 'stale' && selection.sameTicket(generation) && navigation.getAvailabilityRevision() !== availability && navigation.getSnapshot().documentId === null) {
          selectionAttempted.current = false;
          if (selection.isCurrent(generation) && navigation.isAvailable()) setSelectionRetry(current => current + 1);
        }
      });
  }, [selection, registry.ready, registry.active, state.ready, state.heads, state.selectedVersion, state.items, state.folders, navigation, selectionRetry, selected]);
  const selectedOwner = state.items.find(item => item.id === selectedOwnerId && !item.ownerId && item.kind !== 'attachment');
  const enabled = registry.ready && registry.active;
  const canEdit = enabled && state.ready && !state.busy && !state.pendingId && !state.attachment && state.heads.length === 1;
  const selectedCatalog = library.getSelectedSnapshot();
  const formOpen = !!renaming || !!tagDraft || !!folderDraft || !!relationDraft || !!bibliographyDraft;
  const scopeFormHeld = useRef(false); scopeFormHeld.current = formOpen || !!createDraft?.title.trim() || opening;
  useWorkspaceFocusGuard('catalog', () => !scopeFormHeld.current && !comparison && !chooser.current.current() && !state.busy && !state.pendingId && !state.attachment);
  useLayoutEffect(() => binding.sessions.registerScopeViewGuard(() => !scopeFormHeld.current), [binding.sessions]);
  const active = useRef(false);
  useLayoutEffect(() => {
    const show = () => { active.current = true; }, hide = () => { active.current = false; };
    show(); window.addEventListener('pageshow', show); window.addEventListener('pagehide', hide);
    return () => { hide(); window.removeEventListener('pageshow', show); window.removeEventListener('pagehide', hide); };
  }, []);
  const revealFolder = (id: string | null, includeSelf = true) => {
    setOpenKeys(values => {
      const next = new Set(values), seen = new Set<string>();
      let current = includeSelf ? id : (id ? folderById.get(id)?.parentId ?? null : null);
      while (current && !seen.has(current)) { seen.add(current); next.add(canonicalFolderKey(current)); current = folderById.get(current)?.parentId ?? null; }
      return next;
    });
  };
  const revealItems = (ids: readonly string[]) => {
    setOpenKeys(values => {
      const next = new Set(values);
      for (const id of ids) {
        const item = itemById.get(id); if (!item) continue;
        next.add(canonicalItemKey(item.id));
        const seen = new Set<string>();
        let current = (item.ownerId ? itemById.get(item.ownerId)?.folderId : item.folderId) ?? null;
        while (current && !seen.has(current)) { seen.add(current); next.add(canonicalFolderKey(current)); current = folderById.get(current)?.parentId ?? null; }
      }
      return next;
    });
  };
  useEffect(() => {
    const id = state.createdFolderId; if (!id) return;
    selection?.select({ folderId: id }); revealFolder(id, false); setSelectedFolderId(id); setSelectedOwnerId(null); setFocusedKey(canonicalFolderKey(id)); setFocusRequest(value => value + 1);
  }, [state.createdFolderId]); // eslint-disable-line react-hooks/exhaustive-deps -- react once to a new creation, not every catalog poll
  useEffect(() => {
    if (locationKeys) setOpenKeys(values => new Set([...values, ...locationKeys.split('|')]));
  }, [locationKeys]);
  useEffect(() => {
    setChecked(values => { const next = values.filter(id => catalogIds.has(id)); return next.length === values.length ? values : next; });
  }, [catalogIds]);
  useEffect(() => {
    if (enabled && !replication.running && !replication.error && active.current) void library.refresh();
  }, [enabled, replication.running, replication.error, library]);
  const open = async (id: string) => {
    if (!enabled || opening || formOpen) return;
    setOpening(true);
    try {
      const catalog = library.getSnapshot();
      const item = catalog.items.find(value => value.id === id);
      if (!item) return;
      const version = catalog.heads.length > 1 ? catalog.selectedVersion ?? undefined : undefined;
      if (commands) await commands.openContent({ id, kind: item.kind }, version);
      else await navigation.openDocument(id, version);
      if (navigation.getSnapshot().documentId === id) onItemOpen?.();
    } finally { setOpening(false); }
  };
  const openDeleted = async (id: string) => {
    if (!enabled || opening || formOpen) return;
    setOpening(true);
    try {
      const catalog = library.getSnapshot();
      await navigation.openDeletedDocument(id, catalog.heads.length > 1 ? catalog.selectedVersion ?? undefined : undefined);
    } finally { setOpening(false); }
  };
  const create = async () => {
    const draft = createDraft;
    if (!draft) return;
    if (selectedOwner) {
      revealItems([selectedOwner.id]);
      if (!await library.create({ kind: draft.kind, title: draft.title, ownerId: selectedOwner.id })) return;
    } else {
      const folderId = selectedFolder?.id ?? null;
      revealFolder(folderId);
      if (!await library.create({ kind: draft.kind, title: draft.title, folderId })) return;
    }
    setCreateDraft(null);
    setSelectedOwnerId(null);
    scopeFormHeld.current = formOpen || opening;
    const id = library.getSnapshot().createdId;
    if (id) await open(id);
  };
  const retry = async () => {
    const creating = library.getSnapshot().pendingKind === 'create';
    if (!await library.retry()) return;
    if (!creating) { setRenaming(null); setTagDraft(null); setFolderDraft(null); setRelationDraft(null); setBibliographyDraft(null); return; }
    setCreateDraft(null);
    setSelectedOwnerId(null);
    scopeFormHeld.current = formOpen || opening;
    const id = library.getSnapshot().createdId;
    if (id) await open(id);
  };
  const cancelCreate = async () => {
    await library.cancelCreate();
  };
  const importAttachment = async (file: File, ownerId: string) => {
    revealItems([ownerId]);
    const saved = await library.importAttachment({ ownerId, name: file.name, mediaType: file.type || 'application/octet-stream',
      read: async () => new Uint8Array(await file.arrayBuffer()) });
    const id = library.getSnapshot().createdId; if (saved && id) await open(id);
  };
  const importPdf = async (file: File) => {
    const folderId = selectedFolder?.id ?? null;
    revealFolder(folderId);
    const saved = await library.importPdf({ name: file.name, folderId, read: async () => new Uint8Array(await file.arrayBuffer()) });
    const id = library.getSnapshot().createdId; if (saved && id) await open(id);
  };
  const editTags = (mode: LibraryTagDraft['mode'], ids: string[]) => {
    const targets = state.items.filter(item => ids.includes(item.id));
    const existing = [...new Set(targets.flatMap(item => item.tags))], text = mode === 'replace' ? existing.join('\n') : '';
    setTagDraft({ ids: [...ids], mode, existing, text, initialText: text, removing: [],
      expectedTags: Object.fromEntries(targets.map(item => [item.id, [...item.tags]])) });
  };
  const openLinkDraft = (sourceIds: string[]) => {
    const sources = sourceIds.map(id => itemById.get(id)).filter(Boolean);
    const allPdf = sources.length > 0 && sources.every(item => item?.kind === 'pdf' && !item.ownerId);
    const candidates = allPdf
      ? state.items.filter(item => !item.ownerId && (item.kind === 'markdown' || item.kind === 'notebook'))
      : state.items.filter(item => !item.ownerId && item.kind === 'pdf');
    setRelationDraft({ mode: 'link', sourceIds: [...sourceIds], targetId: candidates[0]?.id ?? '' });
  };
  const saveRelation = async () => {
    if (!relationDraft) return;
    const draft = relationDraft;
    if (draft.mode === 'link') {
      const target = itemById.get(draft.targetId);
      const links = draft.sourceIds.map(id => canLinkLibraryItems(itemById.get(id), target)).filter(value => value !== null);
      if (!links.length || links.length !== draft.sourceIds.length) return;
      revealItems([...draft.sourceIds, draft.targetId]);
      if (await library.addLinks(links)) setRelationDraft(null);
      return;
    }
    if (draft.childNotes === 'detach') {
      for (const id of draft.ids) revealFolder(itemById.get(id)?.folderId ?? null);
    }
    if (await library.deleteItems(draft.ids, draft.childNotes)) setRelationDraft(null);
  };
  const saveFolder = async () => {
    if (!folderDraft) return;
    const draft = folderDraft;
    const parentId = draft.mode === 'remove' ? (folderById.get(draft.id!)?.parentId ?? draft.parentId) : draft.parentId;
    revealFolder(parentId);
    const saved = draft.mode === 'create' ? await library.createFolder(draft.title, draft.parentId)
      : draft.mode === 'rename' ? await library.renameFolder(draft.id!, draft.title, draft.expectedTitle)
        : draft.mode === 'move-folder' ? await library.moveFolder(draft.id!, draft.parentId)
          : draft.mode === 'move-items' ? await library.moveItems(draft.ids!, draft.parentId) : await library.removeFolder(draft.id!);
    if (saved) {
      revealFolder(parentId); setFolderDraft(null);
      if (draft.mode === 'remove') {
        setSelectedFolderId(parentId); setSelectedOwnerId(null); setFocusedKey(parentId ? canonicalFolderKey(parentId) : null); setFocusRequest(value => value + 1);
      } else if (draft.mode !== 'create' && draft.mode !== 'move-items') {
        setSelectedFolderId(draft.id!); setSelectedOwnerId(null); setFocusedKey(canonicalFolderKey(draft.id!)); setFocusRequest(value => value + 1);
      }
    }
  };
  const folderTargetsAvailable = !folderDraft || folderDraft.mode === 'create' ? true
    : folderDraft.mode === 'move-items' ? !!folderDraft.ids?.length && folderDraft.ids.every(id => { const item = itemById.get(id); return !!item && !item.ownerId; })
      : !!folderDraft.id && folderById.has(folderDraft.id);
  const canBulkLink = checkedIds.length > 0 && (
    checkedIds.every(id => { const item = itemById.get(id); return item?.kind === 'pdf' && !item.ownerId; })
    || (checkedIds.length === 1 && (() => { const item = itemById.get(checkedIds[0]); return !!item && !item.ownerId && (item.kind === 'markdown' || item.kind === 'notebook'); })())
  );
  const hasActiveFilters = display.query.scope !== 'metadata' || display.query.tag !== '' || display.query.read !== 'all'
    || display.query.sort !== 'position' || display.query.descending;
  const allTags = useMemo(
    () => [...new Set([...state.items.flatMap(item => item.tags), ...(display.query.tag ? [display.query.tag] : [])])].sort(),
    [state.items, display.query.tag],
  );

  const showCreatedBanner = !!state.createdId && state.createdId !== selected.documentId;
  return <section aria-label="資料一覧" className="flex h-full min-h-0 flex-col" onKeyDown={event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey
      || (event.target as Element).closest('input:not([type="checkbox"]),textarea,select,[contenteditable="true"]')) return;
    if (event.key.toLowerCase() === 'a' && enabled && !state.busy && !formOpen) {
      event.preventDefault(); event.stopPropagation(); setChecked([...visibleIds]); return;
    }
    if (event.key.toLowerCase() !== 'z' || !canEdit || formOpen || !(event.shiftKey ? state.canRedo : state.canUndo)) return;
    event.preventDefault(); event.stopPropagation();
    void (event.shiftKey ? library.redo() : library.undo());
  }}>
    <input ref={attachAttachment} type="file" className="hidden" aria-label="取り込む添付ファイル" disabled={!canEdit || formOpen}
      onChange={event => {
        const file = event.currentTarget.files?.[0], ownerId = attachmentOwner.current; event.currentTarget.value = '';
        const token = chooser.current.current() ?? chooser.current.begin()!;
        if (file && ownerId) void importAttachment(file, ownerId).finally(() => finishFile(token));
        else finishFile(token);
      }} />
    <input ref={attachPdf} type="file" accept="application/pdf,.pdf" className="hidden" aria-label="取り込むPDF" disabled={!canEdit || formOpen}
      onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        const token = chooser.current.current() ?? chooser.current.begin()!;
        if (file) void importPdf(file).finally(() => finishFile(token)); else finishFile(token); }} />

    <div role="search" aria-label="資料検索" className="shrink-0 space-y-2 border-b px-2.5 py-2">
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" aria-label="資料の検索語" placeholder="資料を検索…" maxLength={1000} value={display.query.text}
            className="h-7 pl-7 pr-6 text-xs"
            onChange={event => { void library.query.setQuery({ text: event.target.value }); }} />
          {display.query.text && (
            <button type="button" aria-label="検索語をクリア"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => { void library.query.setQuery({ text: '' }); }}>
              <X className="size-3" />
            </button>
          )}
        </div>
        <Button type="button" variant={filtersOpen || hasActiveFilters ? 'secondary' : 'ghost'} size="icon-sm"
          aria-label="検索・並び替え条件" title="検索・並び替え条件" aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(value => !value)}>
          <SlidersHorizontal className="size-3.5" />
        </Button>
      </div>
      {filtersOpen && <div className="grid grid-cols-2 gap-1.5 rounded-md border bg-background p-2 text-xs">
        <label className="col-span-2 space-y-1">
          <span className="text-muted-foreground">検索範囲</span>
          <NativeSelect aria-label="資料の検索範囲" className="h-7 text-xs" value={display.query.scope}
            onChange={event => { void library.query.setQuery({ scope: event.target.value as LibraryQuery['scope'] }); }}>
            <option value="metadata">名前・タグ・書誌情報</option><option value="content">保存済み本文</option><option value="all">情報と保存済み本文</option>
          </NativeSelect>
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">タグ</span>
          <NativeSelect aria-label="資料のタグ条件" className="h-7 text-xs" value={display.query.tag}
            onChange={event => { void library.query.setQuery({ tag: event.target.value }); }}>
            <option value="">すべてのタグ</option>
            {allTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
          </NativeSelect>
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">読書状態</span>
          <NativeSelect aria-label="資料の読書状態" className="h-7 text-xs" value={display.query.read}
            onChange={event => { void library.query.setQuery({ read: event.target.value as LibraryQuery['read'] }); }}>
            <option value="all">すべて</option><option value="read">既読</option><option value="unread">未読</option>
          </NativeSelect>
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">並び順</span>
          <NativeSelect aria-label="資料の並び順" className="h-7 text-xs" value={display.query.sort}
            onChange={event => { void library.query.setQuery({ sort: event.target.value as LibraryQuery['sort'] }); }}>
            <option value="position">保存した順序</option><option value="title">名前</option><option value="year">出版年</option><option value="author">筆頭著者</option>
          </NativeSelect>
        </label>
        <div className="flex items-end justify-between gap-2 pb-1">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" aria-label="資料を降順に表示" checked={display.query.descending}
              onChange={event => { void library.query.setQuery({ descending: event.target.checked }); }} />降順
          </label>
          <Button type="button" variant="ghost" size="xs" onClick={() => { void library.query.clear(); }}>表示条件を解除</Button>
        </div>
      </div>}
    </div>

    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1 text-xs">
      <Button type="button" variant="outline" size="xs" disabled={!canEdit || formOpen}
        onClick={() => { setSelectedOwnerId(null); setCreateDraft({ title: '', kind: 'markdown' }); }}>
        <Plus className="size-3.5" />新規
      </Button>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="PDFを取り込む" title="PDFを取り込む"
        disabled={!canEdit || formOpen} onClick={() => chooseFile(pdfInput.current)}>
        <FilePlus2 className="size-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="フォルダーを作成" title="フォルダーを作成"
        disabled={!canEdit || formOpen} onClick={() => setFolderDraft({ mode: 'create', title: '', parentId: selectedFolder?.id ?? null })}>
        <FolderPlus className="size-3.5" />
      </Button>
      <div className="ml-auto flex items-center gap-0.5">
        <Button type="button" variant="ghost" size="icon-xs" aria-label="資料の変更を元に戻す" title="資料の変更を元に戻す"
          disabled={!canEdit || formOpen || !state.canUndo} onClick={() => { void library.undo(); }}>
          <Undo2 className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="資料の変更をやり直す" title="資料の変更をやり直す"
          disabled={!canEdit || formOpen || !state.canRedo} onClick={() => { void library.redo(); }}>
          <Redo2 className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="一覧を更新" title="一覧を更新"
          disabled={!enabled || state.busy} onClick={() => {
            const sync = replication.suspended ? Promise.resolve() : binding.replication.flush().catch(() => undefined);
            void sync.then(() => library.refresh()).then(() => library.query.retry());
          }}>
          <RefreshCw className={state.busy || replication.running ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="一覧の操作" title="一覧の操作"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-44">
            <DropdownMenuItem disabled={!selected.documentId || !itemById.has(selected.documentId)} onClick={() => {
              if (!selected.documentId) return;
              void library.query.reveal(selected.documentId); revealItems([selected.documentId]);
              setFocusedKey(canonicalItemKey(selected.documentId)); setFocusRequest(value => value + 1);
            }}>表示中の資料を一覧で表示</DropdownMenuItem>
            <DropdownMenuItem disabled={!enabled || state.busy || formOpen || !visibleIds.size} onClick={() => setChecked([...visibleIds])}>すべて選択</DropdownMenuItem>
            <DropdownMenuItem disabled={formOpen} onClick={() => { setSelectedFolderId(null); setSelectedOwnerId(null); }}>未分類を選択</DropdownMenuItem>
            {checkedIds.length > 0 && <DropdownMenuItem disabled={formOpen} onClick={() => setChecked([])}>選択を解除</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    {selectedFolder && (
      <div className="flex shrink-0 items-center justify-between border-b bg-muted/40 px-2.5 py-1 text-[0.75rem] text-muted-foreground">
        <span className="truncate">選択中: {selectedFolder.title}</span>
        <button type="button" className="shrink-0 rounded px-1 hover:bg-muted hover:text-foreground" onClick={() => { setSelectedFolderId(null); setSelectedOwnerId(null); }}>未分類へ</button>
      </div>
    )}

    {checkedIds.length > 0 && (
      <div className="shrink-0 space-y-1.5 border-b bg-accent/50 px-2.5 py-1.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{checkedIds.length}件を選択</span>
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="xs" disabled={!enabled || state.busy || formOpen || !visibleIds.size} onClick={() => setChecked([...visibleIds])}>すべて選択</Button>
            <Button type="button" variant="ghost" size="xs" disabled={formOpen} onClick={() => setChecked([])}>選択を解除</Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button type="button" variant="outline" size="xs" disabled={!canEdit || formOpen} onClick={() => { void library.setRead(checkedIds, true); }}>既読にする</Button>
          <Button type="button" variant="outline" size="xs" disabled={!canEdit || formOpen} onClick={() => { void library.setRead(checkedIds, false); }}>未読にする</Button>
          <Button type="button" variant="outline" size="xs" disabled={!canEdit || formOpen} onClick={() => editTags('add', checkedIds)}>タグを追加</Button>
          <Button type="button" variant="outline" size="xs" disabled={!canEdit || formOpen} onClick={() => editTags('remove', checkedIds)}>タグを削除</Button>
          <Button type="button" variant="outline" size="xs" disabled={!canEdit || formOpen || checkedIds.some(id => !!itemById.get(id)?.ownerId)}
            onClick={() => setFolderDraft({ mode: 'move-items', ids: [...checkedIds], title: '', parentId: selectedFolder?.id ?? null })}>選択した資料を移動</Button>
          <Button type="button" variant="outline" size="xs" disabled={!canEdit || formOpen || !canBulkLink} onClick={() => openLinkDraft(checkedIds)}>関連を追加</Button>
          <Button type="button" variant="destructive" size="xs" disabled={!canEdit || formOpen}
            onClick={() => setRelationDraft({ mode: 'delete', ids: [...checkedIds], childNotes: 'detach' })}>選択した資料を削除</Button>
        </div>
      </div>
    )}

    {((!state.ready && !state.error) || state.busy || replication.running || replication.suspended || (!!replication.error && !replication.suspended)
      || state.error || display.preferenceError || display.loading || display.flat || display.query.scope !== 'metadata'
      || display.missingIds.length > 0 || display.partialIds.length > 0 || display.unsupportedIds.length > 0 || display.error || state.pendingId
      || (state.attachment && !state.pendingId) || showCreatedBanner || state.heads.length > 1 || library.canDiscardRejectedResolution()) && (
      <div className="shrink-0 space-y-1.5 border-b px-2.5 py-1.5 text-xs">
        {(!state.ready && !state.error || state.busy) && <p role="status" className="text-muted-foreground">資料を確認しています…</p>}
        {replication.running && <p role="status" className="text-muted-foreground">同期中…</p>}
        {replication.suspended && <p role="status" className="text-muted-foreground">同期停止中（未送信の変更は保持されます）</p>}
        {replication.error && !replication.suspended && <p role="alert" className="text-destructive">同期を確認できませんでした。一覧を更新して再試行できます。</p>}
        {state.error && <p role="alert" className="text-destructive">{state.pendingId
          ? state.pendingKind === 'create' ? '作成の完了を確認できません。同じ操作を再試行できます。' : '変更の完了を確認できません。同じ操作を再試行できます。'
          : state.error === 'library-head-selection-required' ? '一覧に複数の版があります。表示する版を選んでください。'
            : state.error.includes('library-title-changed') || state.error.includes('library-folder-title-changed') ? '名前が別の操作で変更されています。入力は保持しています。現在の名前を確認してください。'
              : state.error.includes('library-tags-changed') ? 'タグが別の操作で変更されています。入力は保持しています。現在のタグを確認してください。'
                : state.error.includes('library-metadata-changed') ? '書誌情報が別の操作で変更されています。入力は保持しています。現在の内容を確認してください。'
                  : state.error.includes('library-delete-target-busy') ? '未保存または送信待ちの編集があるため削除できません。編集を完了してから再試行してください。'
            : '資料一覧を確認できません。入力や保存済みの内容は保持しています。'}</p>}
        {(state.heads.length > 1 || library.canDiscardRejectedResolution()) && <LibraryConflictPanel port={{
          heads: state.heads, busy: !enabled || state.busy || formOpen,
          canDiscardRejected: library.canDiscardRejectedResolution(),
          compare: () => enabled && !formOpen && library.canLeave() ? library.conflictVersions() : [],
          checkout: version => enabled && !formOpen && library.canLeave() ? library.refresh(version) : Promise.resolve(false),
          adopt: (version, heads) => enabled && !formOpen && library.canLeave() ? library.resolveConflict(version, heads) : Promise.resolve(false),
          discardRejected: () => enabled && !formOpen ? library.discardRejectedResolution() : Promise.resolve(false),
        }} />}
        {state.heads.length > 1 && <label className="block space-y-1">
          <span className="text-muted-foreground">一覧の版</span>
          <NativeSelect aria-label="一覧の版" className="h-7 text-xs" value={state.selectedVersion ?? ''} disabled={state.busy || !enabled}
            onChange={event => { if (event.target.value) { setChecked([]); setSelectedFolderId(null); setSelectedOwnerId(null); setFocusedKey(null); setOpenKeys(new Set()); setRenaming(null); setTagDraft(null); setFolderDraft(null); setRelationDraft(null); setBibliographyDraft(null); void library.refresh(event.target.value); } }}>
            <option value="" disabled>表示する版を選択</option>
            {state.heads.map((head, index) => <option key={head} value={head}>版 {index + 1}</option>)}
          </NativeSelect>
        </label>}
        {display.preferenceError && <p role="alert" className="text-destructive">検索条件を保存または復元できません。条件を確認してください。 <Button type="button" variant="link" size="xs" onClick={() => { void library.query.retryPreference(); }}>検索条件を再試行</Button></p>}
        {display.loading && <p role="status" className="text-muted-foreground">保存済み本文を検索しています…</p>}
        {display.flat && !display.loading && <p role="status" className="text-muted-foreground">{display.ids.length}件の資料が一致</p>}
        {display.query.scope !== 'metadata' && <p className="text-muted-foreground">保存済みのMarkdown・PDF原文／訳文・注釈を対象にします。競合する版を含みます。未保存の入力・OCR・画像の文字は含みません。</p>}
        {(display.missingIds.length > 0 || display.partialIds.length > 0 || display.unsupportedIds.length > 0) && <p role="status" className="text-muted-foreground">
          本文の未取得 {display.missingIds.length}件、一部のみ取得 {display.partialIds.length}件、未対応の添付 {display.unsupportedIds.length}件。取得できた範囲の結果です。
        </p>}
        {display.error && <p role="alert" className="text-destructive">本文を取得できませんでした。一覧を更新して再試行できます。</p>}
        {showCreatedBanner && <p role="status" className="flex items-center justify-between gap-2 text-muted-foreground">
          <span>資料を作成しました。</span>
          <Button type="button" variant="link" size="xs" disabled={!enabled || opening || formOpen}
            onClick={() => { if (state.createdId) void open(state.createdId); }}>作成した資料を開く</Button>
        </p>}
        {state.pendingId && <div className="flex flex-wrap gap-1.5">
          <Button type="button" variant="outline" size="xs" disabled={!enabled || state.busy} onClick={() => { void retry(); }}>{state.pendingKind === 'create' ? '作成を再試行' : '変更を再試行'}</Button>
          {state.pendingKind === 'create' && <Button type="button" variant="ghost" size="xs" disabled={!enabled || state.busy} onClick={() => { void cancelCreate(); }}>作成を取り消す</Button>}
        </div>}
        {state.attachment && !state.pendingId && <div role="status" className="space-y-1">
          <p>{state.attachment.pdf ? 'PDF' : '添付'}「{state.attachment.filename}」{state.attachment.phase === 'reading' ? 'を読み込んでいます…'
            : state.attachment.phase === 'failed' ? 'を保存できませんでした。元の入力は保持しています。' : 'を保存しています…'}</p>
          <div className="flex gap-1.5">
            {state.attachment.phase === 'failed' && <Button type="button" variant="outline" size="xs" disabled={!enabled || state.busy} onClick={() => {
              void library.retryAttachment().then(saved => { const id = library.getSnapshot().createdId; if (saved && id) void open(id); });
            }}>{state.attachment.pdf ? 'PDFの取込みを再試行' : '添付を再試行'}</Button>}
            <Button type="button" variant="ghost" size="xs" disabled={!enabled} onClick={() => { void library.cancelAttachment(); }}>{state.attachment.pdf ? 'PDFの取込みを取り消す' : '添付を取り消す'}</Button>
          </div>
        </div>}
      </div>
    )}

    <LibraryHierarchy rows={rows} focusedKey={focusedKey} focusRequest={focusRequest} selectedFolderId={selectedFolder?.id ?? null}
      focus={setFocusedKey}
      toggle={(key, open) => setOpenKeys(values => { const next = new Set(values); if (open) next.add(key); else next.delete(key); return next; })}
      selectFolder={id => { selection?.select({ folderId: id }); setSelectedFolderId(id); setSelectedOwnerId(null); setFocusedKey(canonicalFolderKey(id)); }}
      openItem={id => { void open(id); }}
      selectItem={id => { if (enabled && !state.busy && !formOpen) setChecked(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id]); }}
      canMoveEntry={(source, target, placement) => {
        if (!canEdit || formOpen || !selectedCatalog) return false;
        try { return reorderLibraryEntry(selectedCatalog, source, target, placement).length > 0; } catch { return false; }
      }}
      moveEntry={(source, target, placement) => {
        if (!canEdit || formOpen) return;
        void library.reorderEntry(source, target, placement).then(ok => {
          if (!ok) return;
          const snapshot = library.getSelectedSnapshot();
          const parent = source.kind === 'folder' ? snapshot?.folders.find(folder => folder.id === source.id)?.parentId
            : snapshot?.items.find(item => item.id === source.id)?.folderId;
          if (parent) setOpenKeys(values => new Set([...values, canonicalFolderKey(parent)]));
          setFocusedKey(source.kind === 'folder' ? canonicalFolderKey(source.id) : canonicalItemKey(source.id));
          setFocusRequest(value => value + 1);
        });
      }}
      canDragItem={id => { const item = itemById.get(id); return canEdit && !formOpen && !!item && !item.ownerId && item.kind !== 'attachment'; }}
      dragIdsForItem={id => checkedIds.includes(id) ? [...checkedIds] : [id]}
      canDropOnItem={(draggedIds, targetId) => canEdit && !formOpen && !!canDropLibraryLinks(draggedIds, targetId, { items: state.items, deletions: state.deletions })}
      dropOnItem={(draggedIds, targetId) => {
        const links = canDropLibraryLinks(draggedIds, targetId, { items: state.items, deletions: state.deletions });
        if (links) { revealItems([...draggedIds, targetId]); void library.addLinks(links); }
      }}
      renderFolder={(row, actions) => (
        <LibraryFolderRowView level={row.depth + 1} selected={row.id === selectedFolder?.id} expanded={row.expanded}
          count={folderCounts.get(row.id) ?? 0}
          onToggle={actions.toggle}
          onClick={() => { selection?.select({ folderId: row.id }); setSelectedFolderId(row.id); setSelectedOwnerId(null); setFocusedKey(canonicalFolderKey(row.id)); }}
          name={<button type="button" className="w-full truncate text-left font-medium" aria-label={`「${row.label}」を選択`}
            onClick={event => { event.stopPropagation(); selection?.select({ folderId: row.id }); setSelectedFolderId(row.id); setSelectedOwnerId(null); setFocusedKey(canonicalFolderKey(row.id)); }}>
            {row.label}
          </button>}
          trailing={
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={`フォルダー「${row.label}」の操作`}
                onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
                className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground hover:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100 data-popup-open:opacity-100">
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max min-w-44">
                <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => { setSelectedFolderId(row.id); setSelectedOwnerId(null); setCreateDraft({ title: '', kind: 'markdown' }); }}>このフォルダーに資料を作成</DropdownMenuItem>
                <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => setFolderDraft({ mode: 'create', title: '', parentId: row.id })}>子フォルダーを作成</DropdownMenuItem>
                <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => {
                  const folder = folderById.get(row.id);
                  if (folder) setFolderDraft({ mode: 'rename', id: folder.id, title: folder.title, expectedTitle: folder.title, parentId: folder.parentId });
                }}>フォルダー名を変更</DropdownMenuItem>
                <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => {
                  const folder = folderById.get(row.id);
                  if (folder) setFolderDraft({ mode: 'move-folder', id: folder.id, title: folder.title, parentId: folder.parentId });
                }}>フォルダーを移動</DropdownMenuItem>
                {actions.startMove && <DropdownMenuItem disabled={!canEdit || formOpen} onClick={actions.startMove}>移動・並べ替え</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={!canEdit || formOpen} onClick={() => {
                  const folder = folderById.get(row.id);
                  if (folder) setFolderDraft({ mode: 'remove', id: folder.id, title: folder.title, parentId: folder.parentId });
                }}>フォルダーを削除（内容を残す）</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          } />
      )}
      renderLink={row => {
        if (!row.link) return null;
        const ownerId = row.link.pdfId === row.id ? row.link.noteId : row.link.pdfId;
        const owner = itemById.get(ownerId), target = itemById.get(row.id);
        return <LibraryChildRowView level={row.depth + 1} kind="link"
          onClick={() => { if (enabled && !opening && (!selected.busy || navigation.isRestoring()) && !formOpen) void open(row.id); }}
          label={<button type="button" className="w-full truncate text-left"
            disabled={!enabled || opening || selected.busy && !navigation.isRestoring() || formOpen}
            onClick={event => { event.stopPropagation(); void open(row.id); }}>{row.label}</button>}
          trailing={owner && target ? (
            <button type="button" disabled={!canEdit || formOpen}
              aria-label={`「${owner.title}」と「${target.title}」の関連を解除`}
              title="関連を解除"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground hover:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100"
              onPointerDown={event => event.stopPropagation()}
              onClick={event => { event.stopPropagation(); void library.removeLinks([row.link!]); }}>
              <X className="size-3" />
            </button>
          ) : undefined} />;
      }}
      renderItem={(id, row, actions) => {
        const item = itemById.get(id); if (!item) return null;
        const isChecked = checkedIds.includes(item.id);
        const isCurrent = item.id === selected.documentId;
        const pdfSummary = item.kind === 'pdf' ? [
          typeof item.metadata.author === 'string' ? item.metadata.author : '',
          typeof item.metadata.year === 'string' && item.metadata.year ? `(${item.metadata.year})` : '',
          typeof item.metadata.venue === 'string' ? item.metadata.venue : '',
        ].filter(Boolean).join(' ') : '';
        const flatLocation = display.flat ? (item.ownerId ? `親資料: ${itemById.get(item.ownerId)?.title ?? ''}`
          : item.folderId ? `フォルダー: ${folderById.get(item.folderId)?.title ?? ''}` : '未分類') : '';
        return <LibraryPaperRowView level={(row?.depth ?? 0) + 1} active={isCurrent} selected={isChecked}
          className={isCurrent && !isChecked ? 'bg-accent/50' : ''}
          notebook={item.kind === 'notebook'} expandable={!!row?.expandable} expanded={!!row?.expanded}
          onToggle={actions?.toggle}
          icon={item.kind === 'attachment' ? <Paperclip className="mr-1.5 mt-0.5 size-4 shrink-0 text-muted-foreground" /> : undefined}
          onClick={() => { if (enabled && !opening && (!selected.busy || navigation.isRestoring()) && !formOpen) void open(item.id); }}
          leading={
            <input type="checkbox" aria-label={`「${item.title}」を選択`} checked={isChecked} disabled={!enabled || state.busy || formOpen}
              className={`mr-1.5 mt-1 size-3.5 shrink-0 accent-primary ${checkedIds.length > 0 || isChecked ? 'opacity-100' : 'opacity-40 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:focus:opacity-100'}`}
              onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
              onChange={event => { const nextSelected = event.currentTarget.checked;
                setChecked(values => nextSelected ? values.includes(item.id) ? values : [...values, item.id] : values.filter(value => value !== item.id)); }} />
          }
          label={
            <div className="flex items-center gap-1.5">
              {!item.read && <span className="size-1.5 shrink-0 rounded-full bg-primary" title="未読" aria-label="未読" />}
              <button type="button" className={`min-w-0 flex-1 truncate text-left ${item.read ? 'text-foreground/80' : 'font-medium text-foreground'}`}
                disabled={!enabled || opening || selected.busy && !navigation.isRestoring() || formOpen}
                aria-current={isCurrent ? 'page' : undefined}
                onClick={event => { event.stopPropagation(); void open(item.id); }}>{item.title}</button>
            </div>
          }
          detail={(flatLocation || pdfSummary) ? <>
            {flatLocation && <span>{flatLocation}</span>}
            {pdfSummary && <span className="truncate">{pdfSummary}</span>}
          </> : undefined}
          tags={item.tags.length > 0 ? <div className="mt-1 flex flex-wrap gap-1">
            {item.tags.map(tag => <TagChip key={tag} name={tag} tabIndex={-1} onClick={() => { void library.query.setQuery({ tag }); }} />)}
          </div> : undefined}
          trailing={
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={`「${item.title}」の操作`}
                onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
                className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground hover:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100 data-popup-open:opacity-100">
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max min-w-44">
                <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => { void library.setRead([item.id], !item.read); }}>
                  {item.read ? '未読にする' : '既読にする'}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => setRenaming({ itemId: item.id, title: item.title, expectedTitle: item.title })}>改名</DropdownMenuItem>
                <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => editTags('replace', [item.id])}>タグを編集</DropdownMenuItem>
                {item.kind === 'pdf' && !item.ownerId && (
                  <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => setBibliographyDraft(createBibliographyDraft(item.id, item.title, item.metadata))}>書誌情報を編集</DropdownMenuItem>
                )}
                {!item.ownerId && item.kind !== 'attachment' && <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => { setSelectedOwnerId(item.id); setSelectedFolderId(null); setCreateDraft({ title: '', kind: 'markdown' }); }}>付属ノートを作成</DropdownMenuItem>
                  <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => { attachmentOwner.current = item.id; chooseFile(attachmentInput.current); }}>ファイルを添付</DropdownMenuItem>
                  <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => openLinkDraft([item.id])}>関連を追加</DropdownMenuItem>
                  <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => setFolderDraft({ mode: 'move-items', ids: [item.id], title: '', parentId: item.folderId })}>フォルダーへ移動</DropdownMenuItem>
                </>}
                {item.ownerId !== null && (item.kind === 'markdown' || item.kind === 'notebook') && (
                  <DropdownMenuItem disabled={!canEdit || formOpen} onClick={() => { revealFolder(itemById.get(item.ownerId!)?.folderId ?? null); void library.detachNotes([item.id]); }}>独立させる</DropdownMenuItem>
                )}
                {actions?.startMove && <DropdownMenuItem disabled={!canEdit || formOpen} onClick={actions.startMove}>移動・並べ替え</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={!canEdit || formOpen} onClick={() => setRelationDraft({ mode: 'delete', ids: [item.id], childNotes: 'detach' })}>削除</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          } />;
      }} />

    {state.ready && state.selectedVersion && !state.items.length && (
      <p className="px-3 py-4 text-center text-xs text-muted-foreground">資料はありません。上部の「新規」またはPDF取込から追加できます。</p>
    )}

    {state.deletedItems.length > 0 && <details className="shrink-0 border-t bg-muted/20 px-2.5 py-1.5 text-xs">
      <summary className="cursor-pointer select-none font-medium text-muted-foreground hover:text-foreground">削除した資料（{state.deletedItems.length}件）</summary>
      <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
        {state.deletedItems.map(deletedItem => {
          const deletion = state.deletions.find(record => record.itemIds.includes(deletedItem.id));
          const contentState = deletedContentById.get(deletedItem.id);
          const ownerTitle = deletedItem.ownerId ? (itemById.get(deletedItem.ownerId)?.title ?? deletedItemById.get(deletedItem.ownerId)?.title) : undefined;
          const ownerStillDeletedElsewhere = !!deletedItem.ownerId && !itemById.has(deletedItem.ownerId)
            && !(deletion?.itemIds.includes(deletedItem.ownerId));
          return <li key={deletedItem.id} className="space-y-1 rounded border bg-background p-1.5">
            <div className="truncate font-medium">{deletedItem.title}</div>
            {ownerTitle && <div className="text-muted-foreground">親資料: {ownerTitle}</div>}
            {contentState && <div className="text-muted-foreground">{contentState.state === 'unobserved'
              ? '未確認の編集あり'
              : contentState.state === 'waiting'
                ? '編集履歴を確認待ち'
                : '削除時点の版を確認済み'}</div>}
            <div className="flex flex-wrap gap-1">
              <Button type="button" variant="outline" size="xs" disabled={!enabled || opening || selected.busy || formOpen}
                aria-label={`削除された「${deletedItem.title}」の内容を確認`}
                onClick={() => { void openDeleted(deletedItem.id); }}>内容を確認</Button>
              {deletion && deletedItem.kind !== 'attachment' && <Button type="button" variant="outline" size="xs"
                disabled={!enabled || opening || selected.busy || formOpen}
                aria-label={`削除された「${deletedItem.title}」を削除時点と比較`}
                onClick={() => setComparison({ deletionId: deletion.id, itemId: deletedItem.id })}>削除時点と比較</Button>}
              {deletion && <Button type="button" variant="secondary" size="xs" disabled={!canEdit || formOpen || ownerStillDeletedElsewhere}
                aria-label={`「${deletedItem.title}」を復元`}
                onClick={() => {
                  revealFolder(deletedItem.folderId);
                  if (deletedItem.ownerId) revealItems([deletedItem.ownerId]);
                  void library.restoreDeleted(deletion.id);
                }}>復元</Button>}
            </div>
          </li>;
        })}
      </ul>
    </details>}

    <Dialog open={!!createDraft} onOpenChange={open => { if (!open && !state.busy) { setCreateDraft(null); setSelectedOwnerId(null); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>新しい資料を作成</DialogTitle></DialogHeader>
        {createDraft && <form className="space-y-4 text-sm" onSubmit={event => { event.preventDefault(); void create(); }}>
          <p className="text-xs text-muted-foreground">作成先: <span className="font-medium text-foreground">{selectedOwner ? `${selectedOwner.title}（付属）` : selectedFolder?.title ?? '未分類'}</span></p>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">新しい資料の名前</span>
            <Input aria-label="新しい資料の名前" autoFocus value={createDraft.title} disabled={state.busy || !!state.pendingId || !!state.attachment}
              onChange={event => {
                const nextTitle = event.target.value;
                scopeFormHeld.current = formOpen || opening || !!nextTitle.trim();
                setCreateDraft(current => current ? { ...current, title: nextTitle } : null);
              }} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">資料の種類</span>
            <NativeSelect aria-label="資料の種類" value={createDraft.kind} disabled={state.busy || !!state.pendingId}
              onChange={event => { const nextKind = event.target.value as LibraryCreateInput['kind']; setCreateDraft(current => current ? { ...current, kind: nextKind } : null); }}>
              <option value="markdown">Markdownノート</option><option value="notebook">手書きノート</option>
            </NativeSelect>
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" disabled={state.busy} onClick={() => { setCreateDraft(null); setSelectedOwnerId(null); }}>キャンセル</Button>
            <Button type="submit" disabled={!canEdit || formOpen || !createDraft.title.trim()}>資料を作成</Button>
          </div>
        </form>}
      </DialogContent>
    </Dialog>

    <Dialog open={!!renaming} onOpenChange={open => { if (!open && !state.busy && !state.pendingId) setRenaming(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>資料の名前を変更</DialogTitle></DialogHeader>
        {renaming && <form className="space-y-4 text-sm" onSubmit={event => {
          event.preventDefault();
          void library.rename(renaming.itemId, renaming.title, renaming.expectedTitle).then(saved => { if (saved) setRenaming(null); });
        }}>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">資料の新しい名前</span>
            <Input aria-label="資料の新しい名前" autoFocus value={renaming.title}
              disabled={state.busy || !!state.pendingId} onChange={event => setRenaming({ ...renaming, title: event.target.value })} />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" disabled={state.busy || !!state.pendingId} onClick={() => setRenaming(null)}>改名を取り消す</Button>
            <Button type="submit" disabled={!canEdit || !renaming.title.trim()}>名前を保存</Button>
          </div>
        </form>}
      </DialogContent>
    </Dialog>

    <Dialog open={!!tagDraft} onOpenChange={open => { if (!open && !state.busy && !state.pendingId) setTagDraft(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>タグを編集</DialogTitle></DialogHeader>
        {tagDraft && <LibraryTagEditor draft={tagDraft} busy={state.busy || !!state.pendingId} canApply={canEdit}
          targetsAvailable={tagDraft.ids.every(id => catalogIds.has(id))} cancel={() => setTagDraft(null)}
          change={update => setTagDraft(current => current ? update(current) : null)}
          apply={async input => { const saved = await library.updateTags(tagDraft.ids, input); if (saved) setTagDraft(null); return saved; }} />}
      </DialogContent>
    </Dialog>

    <Dialog open={!!folderDraft} onOpenChange={open => { if (!open && !state.busy && !state.pendingId) setFolderDraft(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>フォルダーの操作</DialogTitle></DialogHeader>
        {folderDraft && <LibraryFolderEditor draft={folderDraft} folders={state.folders} targetsAvailable={folderTargetsAvailable} busy={state.busy || !!state.pendingId} canApply={canEdit}
          change={update => setFolderDraft(current => current ? update(current) : null)} save={() => { void saveFolder(); }} cancel={() => setFolderDraft(null)} />}
      </DialogContent>
    </Dialog>

    <Dialog open={!!relationDraft} onOpenChange={open => { if (!open && !state.busy && !state.pendingId) setRelationDraft(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{relationDraft?.mode === 'link' ? '関連を追加' : '資料を削除'}</DialogTitle></DialogHeader>
        {relationDraft && <LibraryRelationEditor draft={relationDraft} items={state.items} busy={state.busy || !!state.pendingId} canApply={canEdit}
          change={update => setRelationDraft(current => current ? update(current) : null)} save={() => { void saveRelation(); }} cancel={() => setRelationDraft(null)} />}
      </DialogContent>
    </Dialog>

    <Dialog open={!!bibliographyDraft} onOpenChange={open => { if (!open && !state.busy && !state.pendingId) setBibliographyDraft(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>書誌情報の編集</DialogTitle></DialogHeader>
        {bibliographyDraft && <LibraryBibliographyEditor draft={bibliographyDraft}
          targetAvailable={itemById.get(bibliographyDraft.itemId)?.kind === 'pdf'}
          busy={state.busy || !!state.pendingId} canApply={canEdit}
          change={update => setBibliographyDraft(current => current ? update(current) : null)}
          save={() => {
            void library.updateBibliography(bibliographyDraft.itemId, bibliographyDraft.values, bibliographyDraft.expectedMetadata)
              .then(saved => { if (saved) setBibliographyDraft(null); });
          }}
          cancel={() => setBibliographyDraft(null)} />}
      </DialogContent>
    </Dialog>

    <DeletedContentComparisonConnection binding={binding} request={comparison} canRestore={canEdit && !formOpen}
      close={() => setComparison(null)} />
  </section>;
}

