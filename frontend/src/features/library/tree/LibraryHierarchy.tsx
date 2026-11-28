import { useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '../../../components/ui/button';
import { canonicalTreeFocus, canonicalTreeKey, paginateCanonicalLibraryRows, type CanonicalLibraryRow } from './canonicalLibraryTree';
import type { LibraryTreeEntry, LibraryTreePlacement } from './canonicalLibraryReorder';

export type HierarchyRowActions = { startMove?: () => void; toggle(): void };

export function LibraryHierarchy({ rows, focusedKey, focusRequest, selectedFolderId, focus, toggle, selectFolder, selectItem, openItem, renderFolder, renderItem, renderLink,
  canDragItem, dragIdsForItem, canDropOnItem, dropOnItem, canMoveEntry, moveEntry }: {
  rows: CanonicalLibraryRow[]; focusedKey: string | null; focusRequest: number; selectedFolderId: string | null;
  focus(key: string): void; toggle(key: string, open: boolean): void; selectFolder(id: string): void; selectItem(id: string): void; openItem(id: string): void;
  renderFolder?(row: CanonicalLibraryRow, actions: HierarchyRowActions): ReactNode;
  renderItem(id: string, row?: CanonicalLibraryRow, actions?: HierarchyRowActions): ReactNode;
  renderLink?(row: CanonicalLibraryRow): ReactNode;
  canDragItem?(id: string): boolean; dragIdsForItem?(id: string): string[];
  canDropOnItem?(draggedIds: readonly string[], targetId: string): boolean; dropOnItem?(draggedIds: readonly string[], targetId: string): void;
  canMoveEntry?(source: LibraryTreeEntry, target: LibraryTreeEntry | null, placement: LibraryTreePlacement): boolean;
  moveEntry?(source: LibraryTreeEntry, target: LibraryTreeEntry | null, placement: LibraryTreePlacement): void;
}) {
  const tree = useRef<HTMLDivElement>(null), nodes = useRef(new Map<string, HTMLDivElement>());
  const previous = useRef<CanonicalLibraryRow[]>([]), held = useRef(false), request = useRef(focusRequest);
  const dragging = useRef<string[]>([]);
  const hierarchyDrag = useRef<LibraryTreeEntry | null>(null), pendingFocus = useRef<string | null>(null);
  const [moving, setMoving] = useState<LibraryTreeEntry | null>(null);
  const [limits, setLimits] = useState(new Map<string | null, number>());
  const displayed = paginateCanonicalLibraryRows(rows, limits, focusedKey);
  const current = canonicalTreeFocus(displayed, previous.current, focusedKey);
  const windowed = displayed.length > 100;
  const focusedIndex = displayed.findIndex(row => row.key === current);
  const virtual = useVirtualizer({ count: displayed.length, getScrollElement: () => tree.current, estimateSize: () => 36,
    getItemKey: index => displayed[index].key, overscan: 8, enabled: windowed, initialRect: { width: 280, height: 480 },
    rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ...(focusedIndex >= 0 ? [focusedIndex] : [])])].sort((a, b) => a - b) });
  const revealFocusedNode = (node: HTMLDivElement) => {
    node.focus({ preventScroll: true });
    const reveal = () => { if (node.isConnected && document.activeElement === node) node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); };
    reveal();
    // Dynamic row measurements can adjust the virtual offset after the first layout.
    // Bound the follow-up to two frames and never reclaim focus from a subsequent user action.
    requestAnimationFrame(() => { reveal(); requestAnimationFrame(reveal); });
  };
  const focusRow = (key: string) => { pendingFocus.current = key; focus(key); };
  const more = (row: CanonicalLibraryRow) => {
    const siblings = rows.filter(value => value.parentKey === row.parentKey);
    const count = displayed.filter(value => value.kind !== 'more' && value.parentKey === row.parentKey).length;
    setLimits(values => new Map(values).set(row.parentKey, count + (row.parentKey === null ? 100 : 50)));
    if (siblings[count]) focusRow(siblings[count].key);
  };
  useLayoutEffect(() => {
    const changed = focusedKey !== null && current !== focusedKey;
    if (current && changed) focus(current);
    if (current && (changed && held.current || request.current !== focusRequest)) pendingFocus.current = current;
    const target = pendingFocus.current;
    if (target) {
      const index = displayed.findIndex(row => row.key === target);
      if (windowed && index >= 0) virtual.scrollToIndex(index, { align: 'auto' });
      const node = nodes.current.get(target);
      if (node) {
        revealFocusedNode(node); pendingFocus.current = null;
      }
    }
    previous.current = displayed; request.current = focusRequest;
  });
  const entry = (row: CanonicalLibraryRow): LibraryTreeEntry | null => row.kind === 'folder' || row.kind === 'item' ? { kind: row.kind, id: row.id } : null;
  const readHierarchy = (event: DragEvent): LibraryTreeEntry | null => {
    if (hierarchyDrag.current) return hierarchyDrag.current;
    try {
      const value = JSON.parse(event.dataTransfer.getData('application/x-papeer-library-entry'));
      if (value && ['folder', 'item'].includes(value.kind) && typeof value.id === 'string') return { kind: value.kind, id: value.id };
    } catch { /* A link drag or external payload is not a hierarchy move. */ }
    return null;
  };
  const placement = (event: DragEvent<HTMLDivElement>, row: CanonicalLibraryRow): LibraryTreePlacement => {
    const bounds = event.currentTarget.getBoundingClientRect(), fraction = (event.clientY - bounds.top) / bounds.height;
    return row.kind === 'folder' && fraction >= 0.3 && fraction <= 0.7 ? 'inside' : fraction < 0.5 ? 'before' : 'after';
  };
  const readDragged = (event: DragEvent<HTMLDivElement>): string[] => {
    if (dragging.current.length) return dragging.current;
    try {
      const raw = event.dataTransfer?.getData('application/x-papeer-library-items');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every(id => typeof id === 'string')) return parsed;
      }
    } catch { /* Ignore malformed external payloads. */ }
    const text = event.dataTransfer?.getData('text/plain')?.trim();
    return text ? text.split(',').filter(Boolean) : [];
  };
  const renderRow = (row: CanonicalLibraryRow, index: number, start?: number) => {
    const rowEntry = entry(row);
    const actions: HierarchyRowActions = {
      toggle: () => toggle(row.key, !row.expanded),
      startMove: rowEntry && moveEntry ? () => setMoving(rowEntry) : undefined,
    };
    const isDraggable = (row.kind === 'item' && !!canDragItem?.(row.id)) || (!!rowEntry && !!moveEntry);
    return <div key={row.key} data-index={index}
      ref={node => {
        if (node) {
          nodes.current.set(row.key, node); if (windowed) virtual.measureElement(node);
          if (pendingFocus.current === row.key) requestAnimationFrame(() => {
            if (pendingFocus.current === row.key && node.isConnected) {
              revealFocusedNode(node); pendingFocus.current = null;
            }
          });
        } else nodes.current.delete(row.key);
      }}
      role="treeitem" aria-label={row.kind === 'folder' ? `フォルダー「${row.label}」` : row.label}
      aria-level={row.depth + 1} aria-expanded={row.expandable ? row.expanded : undefined}
      aria-posinset={row.siblingIndex} aria-setsize={row.siblingCount}
      aria-selected={row.kind === 'folder' ? row.id === selectedFolderId : undefined}
      data-library-item={row.kind === 'item' ? row.id : undefined}
      data-library-link={row.kind === 'link' ? row.key : undefined}
      data-folder-id={row.kind === 'folder' ? row.id : undefined}
      data-library-more={row.kind === 'more' ? row.parentKey ?? 'root' : undefined}
      draggable={isDraggable}
      tabIndex={row.key === current ? 0 : -1}
      style={start === undefined ? undefined : { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${start}px)` }}
      className="group/row relative text-[0.8125rem] outline-none"
      onFocus={() => focus(row.key)}
      onDragStart={event => {
        if (!event.dataTransfer) return;
        if (rowEntry && moveEntry && (event.altKey || row.kind === 'folder' || !canDragItem?.(row.id))) {
          event.stopPropagation(); hierarchyDrag.current = rowEntry;
          event.dataTransfer.setData('application/x-papeer-library-entry', JSON.stringify(rowEntry));
          return;
        }
        if (row.kind !== 'item' || !canDragItem?.(row.id)) { event.preventDefault(); return; }
        const ids = dragIdsForItem ? dragIdsForItem(row.id) : [row.id];
        dragging.current = ids;
        event.dataTransfer?.setData('application/x-papeer-library-items', JSON.stringify(ids));
        event.dataTransfer?.setData('text/plain', ids.join(','));
        if (rowEntry && moveEntry) {
          hierarchyDrag.current = rowEntry;
          event.dataTransfer.setData('application/x-papeer-library-entry', JSON.stringify(rowEntry));
        }
      }}
      onDragEnd={() => { dragging.current = []; hierarchyDrag.current = null; }}
      onDragOver={event => {
        if (!event.dataTransfer) return;
        const source = readHierarchy(event), target = entry(row);
        if (source) {
          if (target && canMoveEntry?.(source, target, placement(event, row))) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
          return;
        }
        if (row.kind !== 'item') return;
        const ids = readDragged(event);
        if (ids.length && canDropOnItem?.(ids, row.id)) { event.preventDefault(); event.dataTransfer.dropEffect = 'link'; }
      }}
      onDrop={event => {
        if (!event.dataTransfer) { dragging.current = []; hierarchyDrag.current = null; return; }
        const source = readHierarchy(event), target = entry(row), at = placement(event, row);
        hierarchyDrag.current = null;
        if (source) {
          if (target && canMoveEntry?.(source, target, at)) { event.preventDefault(); event.stopPropagation(); moveEntry?.(source, target, at); }
          return;
        }
        if (row.kind !== 'item') return;
        const ids = readDragged(event); dragging.current = [];
        if (ids.length && canDropOnItem?.(ids, row.id)) { event.preventDefault(); event.stopPropagation(); dropOnItem?.(ids, row.id); }
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
        if (row.kind === 'more' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); more(row); return; }
        const action = canonicalTreeKey(row.kind === 'more' ? displayed : rows, row.key, event.key);
        if (action) {
          event.preventDefault(); event.stopPropagation();
          if (action.type === 'focus') focusRow(action.key); else toggle(action.key, action.type === 'expand');
        } else if (event.key === 'Enter') {
          event.preventDefault(); if (row.kind === 'folder') selectFolder(row.id); else if (row.kind !== 'more') openItem(row.id);
        } else if (event.key === ' ') {
          event.preventDefault(); if (row.kind === 'folder') selectFolder(row.id); else if (row.kind === 'item') selectItem(row.id); else if (row.kind === 'link') openItem(row.id);
        }
      }}>
      {row.kind === 'more' ? (
        <div className="py-1" style={{ paddingLeft: `${row.depth * 16 + 8}px` }}>
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={() => more(row)}>{row.label}</Button>
        </div>
      ) : row.kind === 'folder' ? (
        renderFolder ? renderFolder(row, actions) : (
          <div className="flex items-center gap-1 py-1" style={{ paddingLeft: `${row.depth * 16 + 8}px` }}>
            {row.expandable && <button type="button" aria-label={`「${row.label}」を${row.expanded ? '閉じる' : '開く'}`}
              onClick={() => toggle(row.key, !row.expanded)}>{row.expanded ? '▾' : '▸'}</button>}
            <button type="button" aria-label={`「${row.label}」を選択`} onClick={() => selectFolder(row.id)}>{row.label}</button>
          </div>
        )
      ) : row.kind === 'link' ? (
        renderLink?.(row)
      ) : (
        renderItem(row.id, row, actions)
      )}
      {moving && rowEntry && (
        <div className="flex flex-wrap gap-1 px-2 pb-1" style={{ paddingLeft: `${row.depth * 16 + 24}px` }}>
          {(['before', 'inside', 'after'] as const).map(at => canMoveEntry?.(moving, rowEntry, at) && (
            <Button key={at} type="button" variant="outline" size="xs"
              aria-label={`「${row.label}」の${at === 'inside' ? '中へ移動' : at === 'before' ? '前へ移動' : '後へ移動'}`}
              onClick={() => { moveEntry?.(moving, rowEntry, at); setMoving(null); }}>
              {at === 'inside' ? '中へ' : at === 'before' ? '前へ' : '後へ'}
            </Button>
          ))}
        </div>
      )}
    </div>;
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    {moving && <div role="group" aria-label="移動・並べ替えの対象" className="flex flex-wrap items-center gap-1.5 border-b bg-accent/50 px-2.5 py-1.5 text-xs shrink-0">
      <span className="text-muted-foreground">移動先を選択:</span>
      <Button type="button" variant="outline" size="xs" disabled={!canMoveEntry?.(moving, null, 'inside')} onClick={() => { moveEntry?.(moving, null, 'inside'); setMoving(null); }}>未分類の末尾へ移動</Button>
      <Button type="button" variant="ghost" size="xs" onClick={() => setMoving(null)}>移動・並べ替えを取り消す</Button>
    </div>}
    <div ref={tree} role="tree" aria-label="資料の階層" className="min-h-0 flex-1 overflow-y-auto px-1 py-1"
      onFocusCapture={() => { held.current = true; }}
      onBlurCapture={event => { if (event.relatedTarget && !tree.current?.contains(event.relatedTarget as Node)) held.current = false; }}>
      {windowed ? <div style={{ height: virtual.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtual.getVirtualItems().map(item => renderRow(displayed[item.index], item.index, item.start))}
      </div> : displayed.map((row, index) => renderRow(row, index))}
    </div>
  </div>;
}
