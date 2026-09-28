import { useTagChoices } from "@/api/tagChoices";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { create } from "zustand";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type Announcements, type ClientRect, type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent,
  type KeyboardCodes, type KeyboardCoordinateGetter, type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  ArrowUpDown, BookOpen, ChevronDown, ChevronRight, CircleAlert, Copy, Download, Edit2, ExternalLink, FilePlus2, FileText, Folder,
  FolderOpen, FolderPlus, Loader2, Plus, Save, Search, Tag, Trash2, Undo2, X,
} from "lucide-react";
import { paperDisplayName, useCollections, usePaperList, type PaperData } from "@/api/hooks";
import { useStore } from "@/store";
import {
  ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuLabel, ContextMenuRadioGroup,
  ContextMenuRadioItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  chooseNewCollection, copyBibtex, createFolder, deleteFolder, exportFolderBibtex, importPdfs, movePaper,
  openPaperFile, openPaperFolder, renameFolder, renamePaperFile, saveOriginal, setPaperReadStatus, tagPaper, undoLabel, undoMove,
} from "@/app/actions";
import { deletePapers, movePapers, movePapersToNewCollection, setPapersReadStatus, tagPapers, tagPapersWithNew } from "@/app/bulkActions";
import { useDropTarget } from "@/app/fileDrop";
import { useShownOrganization } from "@/app/useOrganizing";
import { usePendingImports, type PendingImport } from "@/app/pendingImports";
import { allFolderPaths, buildTree, filterPapers, normalizeCollection, type FolderNode } from "./libraryTree";
import {
  dropRowAt, folderKey, nextDropRow, paperKey, rowAfterRemoval, treeKeyAction, typeaheadMatch, visibleRows, type DropRow,
  type TreeKeyAction,
} from "./treeKeys";
import { requestTreeFocus, takeTreeFocus, updateTreeFocus, useTreeFocus } from "./treeFocus";
import {
  papersActedOn, pruneSelection, rowAfterRemovingRows, selectAllPapers, selectRange, toggleSelection,
} from "./paperSelection";
import { changeSelection, clearSelection, openPaper, usePaperSelection } from "./selectionStore";
import { stopBulk, useBulkProgress } from "@/app/bulkState";
import { LibraryTags } from "./LibraryTags";
import { TagChip } from "@/components/ui/TagChip";
import { PaperStatusBadge } from "@/components/ui/PaperStatusBadge";
import { paperTranslationStatus } from "@/lib/paperStatus";
import { TRANSLATION_JOBS } from "@/features/jobs/jobKinds";
import { paperJobState } from "@/features/jobs/jobSelectors";
import { showJobFailure, useJobFailures } from "@/features/jobs/jobFailures";
import { onAppEvent } from "@/lib/appEvents";
import { QK } from "@/lib/queryKeys";
import { SORT_LABELS } from "@/lib/librarySort";

type LibraryHit = { paper_id: string; title: string; side: "metadata" | "note" | "original" | "translated"; page: number | null; snippet: string };

// Defaults that keep their identity from one render to the next, so that the memoized list and tree hold while loading.
const NO_PAPERS: PaperData[] = [];
const NO_COLLECTIONS: string[] = [];

/**
 * Folder under a paper dragged in the tree, and the other papers dragged with it (selected together);
 * kept here so that only the rows it enters and leaves, and the papers dragged, render again.
 */
const useDragOver = create<{ path: string | null; paperIds: ReadonlySet<string> | null }>(() => ({ path: null, paperIds: null }));

/** The keyboard focus of the rows: a ring when focused from the keyboard, in the theme's ring color. */
const FOCUS_RING = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:rounded-sm";

// Choosing a folder or opening a paper (a click, Enter; see openPaper) ends selecting several papers: the
// tree has its one selected row again, and a Shift range starts from the row chosen.
function selectFolder(path: string) {
  clearSelection(folderKey(path));
  const store = useStore.getState();
  store.setSelectedFolder(path);
  store.setCurrentCollection(path);
}

// Deleting or renaming a row removes it, and its focus would fall to the page, where the arrows turn the
// PDF's pages: the keys go on to the row after the deleted one (see rowAfterRemoval), or to the renamed
// folder under its new path.
// A paper in a selection of several deletes the selection (see papersActedOn), and the keys go on to
// the row after the paper that stays.
function deletePaperRow(paperId: string) {
  const rows = useTreeFocus.getState().rows;
  const ids = papersActedOn(usePaperSelection.getState(), rows, paperId);
  const next = rowAfterRemovingRows(rows, paperKey(paperId), new Set(ids.map(paperKey)));
  void deletePapers(ids).then((deleted) => { if (deleted && next) requestTreeFocus(next); });
}

function deleteFolderRow(path: string, papers: PaperData[] | null) {
  const next = rowAfterRemoval(useTreeFocus.getState().rows, folderKey(path));
  void deleteFolder(path, papers).then((deleted) => { if (deleted && next) requestTreeFocus(next); });
}

function renameFolderRow(path: string) {
  void renameFolder(path).then((renamed) => { if (renamed !== null) requestTreeFocus(folderKey(renamed)); });
}

/** The keys that move in the tree, which a button in a row passes on to it. */
const MOVE_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** The moves that Shift extends the selection with, from the anchor to the row moved to. */
const RANGE_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

// Dragging a paper with the keyboard (dnd-kit's KeyboardSensor): Space picks it up, ↑↓ go from folder to
// folder, and Space or Enter puts it down; Esc and Tab put it back. Enter does not pick it up, since it
// opens the paper.
const KEYBOARD_CODES: KeyboardCodes = { start: ["Space"], end: ["Space", "Enter"], cancel: ["Escape", "Tab"] };

const dropRows = (containers: Iterable<{ id: UniqueIdentifier }>, rects: { get(id: UniqueIdentifier): ClientRect | undefined }): DropRow[] =>
  Array.from(containers).flatMap((container) => {
    const rect = rects.get(container.id);
    return rect ? [{ id: String(container.id), top: rect.top, bottom: rect.bottom }] : [];
  });

/** ↑↓ move the dragged paper's middle onto the middle of the folder row above or below (see nextDropRow). */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const direction = event.code === "ArrowDown" ? 1 : event.code === "ArrowUp" ? -1 : 0;
  const { collisionRect, droppableContainers, droppableRects } = context;
  if (!direction || !collisionRect) return undefined;
  event.preventDefault();
  const middle = collisionRect.top + collisionRect.height / 2;
  const target = nextDropRow(dropRows(droppableContainers.getEnabled(), droppableRects), middle, direction);
  return target ? { x: currentCoordinates.x, y: currentCoordinates.y + (target.top + target.bottom) / 2 - middle } : undefined;
};

/** The folder under the pointer, or, dragging with the keyboard, which has no pointer, the one under the paper's middle. */
const detectCollisions: CollisionDetection = (args) => {
  if (args.pointerCoordinates) return pointerWithin(args);
  const { collisionRect, droppableContainers, droppableRects } = args;
  const id = dropRowAt(dropRows(droppableContainers, droppableRects), collisionRect.top + collisionRect.height / 2);
  const container = droppableContainers.find((c) => String(c.id) === id);
  return container ? [{ id: container.id, data: { droppableContainer: container, value: 0 } }] : [];
};

const folderLabel = (id: UniqueIdentifier) => String(id).replace(/^folder:/, "") || "未分類";

/** Takes the keyboard focus when the tree asked for this row (see requestTreeFocus). */
function useFocusRequest(ref: RefObject<HTMLElement | null>, requested: boolean) {
  useEffect(() => {
    if (!requested || !takeTreeFocus()) return;
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [ref, requested]);
}

export function LibrarySidebar() {
  const undoHistory = useStore((s) => s.moveHistory);
  const lastUndo = undoHistory[undoHistory.length - 1];
  const undoText = undoLabel(lastUndo);
  const { data: readingStatuses = [] } = useTagChoices("status");
  const librarySearch = useStore((s) => s.librarySearch);
  const setLibrarySearch = useStore((s) => s.setLibrarySearch);
  const sortOrder = useStore((s) => s.sortOrder);
  const setSortOrder = useStore((s) => s.setSortOrder);
  const currentCollection = useStore((s) => s.currentCollection);
  const setExpandedCollections = useStore((s) => s.setExpandedCollections);

  const [searchText, setSearchText] = useState(librarySearch);
  useEffect(() => setSearchText(librarySearch), [librarySearch]);
  useEffect(() => {
    const timer = setTimeout(() => setLibrarySearch(searchText), 200);
    return () => clearTimeout(timer);
  }, [searchText, setLibrarySearch]);

  const [tagFilter, setTagFilter] = useState("");
  const [readFilter, setReadFilter] = useState("");
  const filtered = !!librarySearch.trim() || !!tagFilter || !!readFilter;
  const { data: paperList, isSuccess: papersLoaded } = usePaperList("", sortOrder);
  const allPapers = paperList ?? NO_PAPERS;
  useEffect(() => {
    if (papersLoaded && tagFilter && !allPapers.some(paper => paper.tags?.includes(tagFilter))) setTagFilter("");
  }, [allPapers, papersLoaded, tagFilter]);
  const { data: searchResults, isFetching: searching, isError: searchError } = useQuery({
    queryKey: [QK.librarySearch, librarySearch],
    // Typing on stops the request of the previous words (their results would only be thrown away).
    queryFn: async ({ signal }) => await unwrap(api.GET("/api/library-search", {
      params: { query: { q: librarySearch } }, signal })) as { results: LibraryHit[]; limited: boolean },
    enabled: !!librarySearch.trim(),
  });
  // Memoized, as is the tree built from it: a new list each render would render every row again.
  const matches = useMemo(() => librarySearch.trim() ? new Set(searchResults?.results.map(hit => hit.paper_id)) : null,
    [librarySearch, searchResults]);
  const papers = useMemo(() => filterPapers(allPapers, { tag: tagFilter, readStatus: readFilter, matches }),
    [allPapers, tagFilter, readFilter, matches]);
  const hits = useMemo(() => {
    const shown = new Set(papers.map(p => p.id));
    return searchResults?.results.filter(hit => shown.has(hit.paper_id)) ?? [];
  }, [papers, searchResults]);
  const { data: collections = NO_COLLECTIONS } = useCollections();
  const pending = usePendingImports((s) => s.items);
  const tree = useMemo(() => buildTree(collections, papers, pending, filtered), [collections, papers, pending, filtered]);

  // The same function until the tree changes, so that the memoized rows keep their props; each row
  // selects whether it is open itself.
  const setExpanded = useCallback((path: string, expanded: boolean) => {
    const current = new Set(useStore.getState().expandedCollections ?? allFolderPaths(tree));
    if (expanded) current.add(path);
    else current.delete(path);
    setExpandedCollections([...current]);
  }, [tree, setExpandedCollections]);

  // The rows on screen, for the keyboard (see treeKeys.ts); none while the search's results replace the tree.
  const expandedCollections = useStore((s) => s.expandedCollections);
  const rows = useMemo(() => {
    if (librarySearch.trim()) return [];
    const open = expandedCollections && new Set(expandedCollections);
    return visibleRows(tree, (path) => filtered || !open || open.has(path), paperDisplayName);
  }, [tree, expandedCollections, filtered, librarySearch]);
  // Before paint, so that the row that takes the Tab key is right as soon as the rows are, and papers
  // that left the screen leave the selection before anything can be done to them.
  useLayoutEffect(() => {
    updateTreeFocus({ rows });
    changeSelection((selection) => pruneSelection(selection, rows));
  }, [rows]);

  // The paper dragged, and every paper dragged with it (itself alone, or the selection it is in).
  const [dragging, setDragging] = useState<{ paper: PaperData; ids: string[] } | null>(null);
  const draggedIds = useRef<string[]>([]);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { keyboardCodes: KEYBOARD_CODES, coordinateGetter: keyboardCoordinates }),
  );
  const paperLabel = (id: UniqueIdentifier) => {
    const paper = allPapers.find((p) => p.id === id);
    return paper ? paperDisplayName(paper) : "論文";
  };
  // Several papers dragged together are named by their count.
  const draggedLabel = (id: UniqueIdentifier) =>
    draggedIds.current.length > 1 ? `${draggedIds.current.length}件の論文` : `「${paperLabel(id)}」`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `${draggedLabel(active.id)}を持ち上げました。`,
    onDragOver: ({ over }) => over ? `移動先：${folderLabel(over.id)}` : "移動先のフォルダーはありません。",
    onDragEnd: ({ active, over }) => over
      ? `${draggedLabel(active.id)}を「${folderLabel(over.id)}」へ移します。` : `${draggedLabel(active.id)}を元の場所に戻しました。`,
    onDragCancel: ({ active }) => `${draggedLabel(active.id)}の移動を取り消しました。`,
  };

  const endDrag = () => {
    clearTimeout(hoverTimer.current);
    setDragging(null);
    useDragOver.setState({ path: null, paperIds: null });
  };
  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    const paper = papers.find((p) => p.id === id);
    // A paper in a selection of several takes the selection with it.
    const ids = papersActedOn(usePaperSelection.getState(), useTreeFocus.getState().rows, id);
    draggedIds.current = ids;
    setDragging(paper ? { paper, ids } : null);
    if (ids.length > 1) useDragOver.setState({ paperIds: new Set(ids) });
  };
  const onDragOver = (event: DragOverEvent) => {
    const target = event.over ? String(event.over.id).replace(/^folder:/, "") : null;
    if (target === useDragOver.getState().path) return;
    useDragOver.setState({ path: target });
    clearTimeout(hoverTimer.current);
    // Hovering a closed folder opens it, so papers can be dropped into subfolders.
    if (target !== null) hoverTimer.current = setTimeout(() => setExpanded(target, true), 700);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const ids = draggedIds.current;
    endDrag();
    if (!event.over) return;
    const paperId = String(event.active.id);
    const destination = String(event.over.id).replace(/^folder:/, "");
    const byKeyboard = event.activatorEvent?.type === "keydown";
    void (ids.length > 1 ? movePapers(ids, destination) : movePaper(paperId, destination)).then((moved) => {
      // The keys stay on the paper, in the folder it moved to once the library shows it there.
      if (moved && byKeyboard) requestTreeFocus(paperKey(paperId), normalizeCollection(destination));
    });
  };

  // The tree's keys (see treeKeyAction), and typing a name's first letters to move to it. Only keys the
  // tree uses are stopped, so that Ctrl+Z and the app's shortcuts still work from a row.
  const treeRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const focusRow = (key: string) => {
    const row = treeRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(key)}"]`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  };
  const applyTreeKey = (action: TreeKeyAction) => {
    if (action.type === "focus") focusRow(action.key);
    else if (action.type === "expand" || action.type === "collapse") setExpanded(action.path, action.type === "expand");
    else if (action.type === "activate") {
      if (action.row.kind === "paper") openPaper(action.row.id, action.row.folder);
      else selectFolder(action.row.id);
    }
  };
  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>, capture: boolean) => {
    // While a paper is dragged with the keyboard, the keys are the drag's.
    if (dragging || e.defaultPrevented || e.nativeEvent.isComposing || e.altKey) return;
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>("[role=treeitem][data-tree-key]");
    if (!item?.dataset.treeKey) return;
    const current = item.dataset.treeKey;
    const onRow = item === target;
    // Keys on a row are taken as they bubble up, after the row's own (Delete, and Space for dnd-kit). A
    // button in a row (clicked, so focused) keeps Enter and letters, and the tags stop every key; the keys
    // that move are taken from it on the way down, so that they still move.
    if (capture ? onRow || !MOVE_KEYS.has(e.key) : !onRow) return;
    const rows = useTreeFocus.getState().rows;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    // Selecting several papers: Ctrl+Space toggles the paper, Shift+Space and Shift+↑↓/Home/End select
    // from the anchor, Ctrl+A every paper on screen, Esc goes back to the one selected row. Other keys
    // with Ctrl are left to the app (Ctrl+Z, Ctrl+L…).
    const command = e.ctrlKey || e.metaKey;
    if (command && !e.shiftKey && e.key.toLowerCase() === "a") {
      stop();
      changeSelection(selectAllPapers);
      return;
    }
    if (command && e.key === " ") {
      stop();
      changeSelection((selection, rows, open) => toggleSelection(selection, rows, current, open));
      return;
    }
    if (command) return;
    if (e.key === "Escape" && usePaperSelection.getState().ids !== null) {
      stop();
      clearSelection(usePaperSelection.getState().anchor);
      return;
    }
    if (e.shiftKey && e.key === " ") {
      stop();
      changeSelection((selection, rows, open) => selectRange(selection, rows, current, open));
      return;
    }
    if (e.key === "F2") {
      // F2 renames the row the keys are on, which may not be the selected one.
      const row = rows.find((r) => r.key === current);
      stop();
      if (row?.kind === "paper") void renamePaperFile(row.id);
      else if (row?.id) renameFolderRow(row.id);
      return;
    }
    const action = treeKeyAction(rows, current, e.key, { canCollapse: !filtered });
    if (action) {
      stop();
      if (e.shiftKey && action.type === "focus" && RANGE_KEYS.has(e.key)) {
        const target = action.key;
        changeSelection((selection, rows, open) => selectRange(selection, rows, target, open, { from: current }));
      }
      applyTreeKey(action);
      return;
    }
    // Space on a folder does nothing rather than scroll the list; on a paper, dnd-kit has taken it to start a drag.
    if (e.key === " ") {
      stop();
      return;
    }
    if (Array.from(e.key).length === 1) {
      const now = Date.now();
      const text = (now - typed.current.at < 700 ? typed.current.text : "") + e.key;
      typed.current = { text, at: now };
      const match = typeaheadMatch(rows, current, text);
      stop();
      if (match) focusRow(match);
    }
  };

  useEffect(() => {
    // Citations and Ctrl+L reveal the paper: open its ancestors and scroll to it, or focus it.
    const reveal = ({ paperId, focus }: { paperId: string; focus: boolean }) => {
      const paper = papers.find((p) => p.id === paperId);
      const expandedCollections = useStore.getState().expandedCollections;
      if (paper && expandedCollections !== null) {
        const parts = normalizeCollection(paper.collection_name || "").split(" / ").filter(Boolean);
        const next = new Set(expandedCollections);
        parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join(" / ")));
        if (!parts.length) next.add("");
        if (next.size !== expandedCollections.length) setExpandedCollections([...next]);
      }
      if (focus) requestTreeFocus(paperKey(paperId));
      else setTimeout(() => document.getElementById(`paper-row-${paperId}`)?.scrollIntoView({ block: "nearest" }), 50);
    };
    const offReveal = onAppEvent("reveal-paper", reveal);
    // Ctrl+L: the row the keys were on while it is on screen, else the open paper, else the row that
    // takes the Tab key; the search box when the tree is empty.
    const offFocus = onAppEvent("focus-library", () => {
      const { rows, focused, tabStop } = useTreeFocus.getState();
      const { activePaperId, selectedFolder } = useStore.getState();
      if (focused !== null && rows.some((row) => row.key === focused)) requestTreeFocus(focused);
      else if (activePaperId && selectedFolder === null && papers.some((p) => p.id === activePaperId)) reveal({ paperId: activePaperId, focus: true });
      else if (tabStop !== null) requestTreeFocus(tabStop);
      else document.getElementById("library-search")?.focus();
    });
    return () => { offReveal(); offFocus(); };
  }, [papers, setExpandedCollections]);

  const clearFilters = () => {
    setSearchText("");
    setLibrarySearch("");
    setTagFilter(""); setReadFilter("");
  };

  return (
    <div className="flex flex-col h-full text-[0.8125rem] select-none" onKeyDown={(event) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable=true], [role=dialog]")) return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z" && lastUndo) {
        event.preventDefault();
        void undoMove();
      }
    }}>
      <div className="p-2 space-y-2 shrink-0">
        <button
          onClick={importPdfs}
          title={`追加するPDFを「${currentCollection || "未分類"}」へ入れます。（Ctrl+O）`}
          className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground h-8 rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <FilePlus2 className="w-4 h-4" />
          PDF を追加
        </button>
        <div className="text-[0.75rem] text-muted-foreground truncate px-0.5" title={currentCollection || "未分類"}>
          追加先：{currentCollection || "未分類"}
        </div>
        <button onClick={undoMove} disabled={!lastUndo} title={`${undoText}（ライブラリ内で Ctrl+Z）`}
          className="w-full flex items-center justify-center gap-2 h-7 border rounded-md hover:bg-muted disabled:opacity-40 disabled:cursor-default">
          <Undo2 className="w-3.5 h-3.5" /> 元に戻す
        </button>
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              id="library-search"
              type="text"
              placeholder="タイトル・本文・メモを検索"
              title="タイトル・ファイル名・本文・メモ・フォルダー名を検索（Ctrl+F）"
              className="w-full h-8 pl-8 pr-7 rounded-md bg-background border text-[0.8125rem] focus:outline-none focus:ring-2 focus:ring-ring"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") clearFilters(); }}
            />
            {searchText && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={clearFilters}
                aria-label="検索を解除"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="w-8 h-8 flex items-center justify-center border rounded-md hover:bg-muted shrink-0"
              title={`並べ替え：${SORT_LABELS[sortOrder]}`}
              aria-label={`並べ替え：${SORT_LABELS[sortOrder]}`}
            >
              <ArrowUpDown className="w-4 h-4 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuRadioGroup value={String(sortOrder)} onValueChange={(v) => setSortOrder(Number(v))}>
                {SORT_LABELS.map((label, index) => (
                  <DropdownMenuRadioItem key={label} value={String(index)}>{label}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            onClick={() => createFolder(null)}
            className="w-8 h-8 flex items-center justify-center border rounded-md hover:bg-muted shrink-0"
            title="フォルダーを作成"
          >
            <FolderPlus className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
        <div className="flex gap-1.5">
          <select aria-label="読書状態で絞り込み" className="min-w-0 flex-1 border rounded bg-background h-7 px-1 text-xs" value={readFilter} onChange={e => setReadFilter(e.target.value)}>
            <option value="">すべての読書状態</option>{Array.from(new Set([...readingStatuses, ...allPapers.map(p => p.read_status).filter((s): s is string => !!s)])).map(status => <option key={status}>{status}</option>)}
          </select>
        </div>
        <LibraryTags papers={allPapers} selected={tagFilter} onSelect={setTagFilter} />
      </div>

      <DndContext sensors={sensors} collisionDetection={detectCollisions} accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: "スペースキーで持ち上げ、上下の矢印キーでフォルダーを選び、スペースキーで移動。Esc で取り消し。",
        },
      }}
        onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={endDrag}>
        <div
          className="flex-1 overflow-auto py-1 outline-none"
          tabIndex={-1}
          title="右クリックで名前変更・子フォルダー作成。論文をドラッグしてフォルダーへ移動。Ctrl・Shift+クリックで複数選択（F2：名前変更、Delete：削除）"
        >
          {librarySearch.trim() && <div className="px-2 text-xs">
            {searching && <p className="p-2 text-muted-foreground">検索中…</p>}
            {searchError && <p className="p-2 text-destructive">検索できませんでした。</p>}
            {hits.map((hit, index) => <button key={index} className="w-full border-b text-left p-2 hover:bg-muted" onClick={() => {
              const store = useStore.getState(); store.setSelectedFolder(null); store.setTranslatedOnly(false);
              store.setActivePaperId(hit.paper_id, hit.page ?? undefined);
              store.setCurrentCollection(allPapers.find(p => p.id === hit.paper_id)?.collection_name ?? "");
              store.setActiveTab(hit.side === "note" ? "notes" : "reader");
              if (hit.page) store.setReaderJump({ paperId: hit.paper_id, page: hit.page, side: hit.side === "translated" ? "translated" : "original", text: librarySearch, anchor_y: 0 });
            }}><span className="block font-medium truncate">{hit.title}</span>
              <span className="text-primary">{{ metadata: "論文情報", note: "メモ", original: "原文", translated: "訳文" }[hit.side]}{hit.page && ` p.${hit.page}`}</span>
              <span className="block text-muted-foreground line-clamp-2">{hit.snippet}</span></button>)}
            {searchResults?.limited && <p className="p-2 text-muted-foreground">先頭200件を表示しています。検索語を追加して絞り込めます。</p>}
          </div>}
          {!librarySearch.trim() && (
            <div ref={treeRef} role="tree" aria-label="ライブラリ" aria-multiselectable="true"
              onKeyDownCapture={(e) => onTreeKeyDown(e, true)} onKeyDown={(e) => onTreeKeyDown(e, false)}>
              {tree.map((node) => (
                <FolderRow key={node.path || "(unfiled)"} node={node} depth={0} papers={paperList ?? null} collections={collections}
                  filtered={filtered} setExpanded={setExpanded} onTagSelect={setTagFilter} />
              ))}
            </div>
          )}
          {papers.length === 0 && pending.length === 0 && (
            <div className="px-4 py-6 text-center text-muted-foreground text-[0.75rem] leading-relaxed">
              {filtered
                ? "見つかりませんでした。検索語や絞り込みを変更してください。"
                : "PDFを追加するか、フォルダーへドロップして読み始めましょう。"}
            </div>
          )}
          {filtered && (
            <div className="px-2 py-1">
              <button onClick={clearFilters} className="w-full h-7 rounded-md border text-[0.75rem] hover:bg-muted">
                検索・絞り込みを解除
              </button>
            </div>
          )}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging && (
            <div className="px-3 py-1.5 rounded-md bg-card border shadow-md text-[0.8125rem] max-w-[16.25rem] truncate">
              {dragging.ids.length > 1
                ? <><span className="font-medium tabular-nums">{dragging.ids.length} 件の論文</span>
                  <span className="block truncate text-xs text-muted-foreground">{paperDisplayName(dragging.paper)} ほか</span></>
                : paperDisplayName(dragging.paper)}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <div className="px-3 py-1.5 text-[0.75rem] text-muted-foreground border-t shrink-0 tabular-nums flex items-center gap-2">
        <span>{papers.length} 件の論文</span>
        <SelectionStatus />
      </div>
    </div>
  );
}

/**
 * How many papers are selected together, with a button that clears the selection; while an action on
 * several papers runs, its progress, with a button that stops it. Apart from the sidebar, so that a
 * change renders this line only.
 */
function SelectionStatus() {
  const count = usePaperSelection((s) => s.ids?.size ?? 0);
  const progress = useBulkProgress((s) => s.progress);
  if (progress) {
    return <>
      <span className="text-foreground truncate">
        {progress.label}…（{Math.min(progress.ran + 1, progress.total)}/{progress.total}）{progress.stopping ? " 中止しています" : ""}
      </span>
      <button onClick={stopBulk} disabled={progress.stopping} title="送信中の 1 件が終わったところで止めます。残りは処理しません。"
        className="ml-auto shrink-0 rounded px-1.5 hover:bg-muted hover:text-foreground disabled:opacity-50">中止</button>
    </>;
  }
  if (!count) return null;
  return <>
    <span className="text-foreground">· {count} 件を選択中</span>
    <button onClick={() => clearSelection(usePaperSelection.getState().anchor)} title="複数選択を解除します（一覧で Esc）"
      className="ml-auto rounded px-1.5 hover:bg-muted hover:text-foreground">解除</button>
  </>;
}

/** Delete on the focused row itself, not on a nested button such as the tag toggle. */
const isDeleteKey = (e: KeyboardEvent<HTMLElement>) => (e.key === "Delete" || e.key === "Backspace") && e.target === e.currentTarget;

/**
 * Props the rows pass down unchanged. They keep their identity from one render to the next (stable
 * callbacks, query data), so that the memoized rows render again only for their own changes.
 */
type RowProps = {
  onTagSelect: (name: string) => void;
  /** The whole library, unfiltered: deleting a folder counts every paper in it. Null until it has loaded. */
  papers: PaperData[] | null;
  collections: string[];
  /** Searching or filtering, which shows every folder open. */
  filtered: boolean;
  setExpanded: (path: string, expanded: boolean) => void;
};

function FolderRowView({ node, depth, ...rest }: { node: FolderNode; depth: number } & RowProps) {
  const { papers, filtered, setExpanded } = rest;
  const { setNodeRef } = useDroppable({ id: `folder:${node.path}` });
  const key = folderKey(node.path);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => { setNodeRef(element); rowRef.current = element; }, [setNodeRef]);
  // Whether this row takes the Tab key, or was asked to take the focus; see treeFocus.ts.
  const tabStop = useTreeFocus((s) => s.tabStop === key);
  useFocusRequest(rowRef, useTreeFocus((s) => s.pending?.key === key));
  // Its contents are a sibling of the row in the page, so the row says that they are its own.
  const groupId = useId();
  const hasContents = node.children.length + node.papers.length + node.pending.length > 0;
  // Booleans, so that selecting, opening or dragging over another row leaves this one as it is.
  const chosen = useStore((s) => s.selectedFolder === node.path);
  // While several papers are selected, folders are not; the chosen one keeps its mark, as the folder
  // new PDFs go into.
  // Only the chosen folder's row follows the selection.
  const selected = usePaperSelection((s) => chosen && s.ids === null);
  const expanded = useStore((s) => filtered || s.expandedCollections === null || s.expandedCollections.includes(node.path));
  const draggedOver = useDragOver((s) => s.path === node.path);
  const osDraggedOver = useDropTarget((s) => s.target === node.path);
  const highlighted = draggedOver || osDraggedOver;

  return (
    <div role="none">
      <ContextMenu>
        <ContextMenuTrigger role="none">
          <div
            ref={ref}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={hasContents ? expanded : undefined}
            aria-owns={hasContents && expanded ? groupId : undefined}
            aria-selected={selected}
            aria-label={`${node.name}（${node.count}件）`}
            data-tree-key={key}
            data-drop-collection={node.path}
            className={`flex items-center h-[1.875rem] cursor-pointer group border-l-2 ${FOCUS_RING} ${
              selected ? "bg-accent" : "hover:bg-muted/60"} ${chosen ? "border-primary" : "border-transparent"
            } ${highlighted ? "outline-2 outline-primary -outline-offset-2 rounded-sm" : ""}`}
            style={{ paddingLeft: `${depth * 16 + 6}px`, paddingRight: "8px" }}
            tabIndex={tabStop ? 0 : -1}
            onFocus={(e) => { if (e.target === e.currentTarget) updateTreeFocus({ focused: key }); }}
            onClick={(e) => {
              // Shift selects the papers from the anchor down to here; Ctrl leaves the selection as it is.
              if (e.shiftKey) changeSelection((selection, rows, open) => selectRange(selection, rows, key, open, { add: e.ctrlKey || e.metaKey }));
              else if (!e.ctrlKey && !e.metaKey) selectFolder(node.path);
            }}
            onDoubleClick={() => setExpanded(node.path, !expanded)}
            onKeyDown={(e) => { if (node.path && isDeleteKey(e)) { e.preventDefault(); deleteFolderRow(node.path, papers); } }}
            // The full path of a subfolder; not the name again, which the label already says.
            title={node.path === node.name ? undefined : node.path || "フォルダー未指定のPDF"}
          >
            {/* Out of the Tab order: ←→ open and close the folder from the row. */}
            <button
              tabIndex={-1}
              className="w-4 h-4 flex items-center justify-center mr-1 text-muted-foreground shrink-0"
              onClick={(e) => { e.stopPropagation(); setExpanded(node.path, !expanded); }}
              aria-label={expanded ? "閉じる" : "開く"}
            >
              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            {expanded ? <FolderOpen className="mr-2 h-4 w-4 text-muted-foreground shrink-0" />
              : <Folder className="mr-2 h-4 w-4 text-muted-foreground shrink-0" />}
            <span className="flex-1 truncate">{node.name}</span>
            <span className="text-[0.75rem] text-muted-foreground tabular-nums ml-2">{node.count}</span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => createFolder(node.path)}>
            <FolderPlus className="w-4 h-4 mr-2" /> {node.path ? "子フォルダーを作成…" : "フォルダーを作成…"}
          </ContextMenuItem>
          {node.path && (
            <>
              <ContextMenuItem onClick={() => renameFolderRow(node.path)}>
                <Edit2 className="w-4 h-4 mr-2" /> 名前を変更…
              </ContextMenuItem>
              {/* The folder's papers and its subfolders', as its count shows them. */}
              <ContextMenuItem disabled={!node.count} onClick={() => void exportFolderBibtex(node.path)}>
                <Download className="w-4 h-4 mr-2" /> BibTeX を書き出す…
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => deleteFolderRow(node.path, papers)} className="text-destructive">
                <Trash2 className="w-4 h-4 mr-2" /> フォルダーを削除
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {expanded && (
        <div role="group" id={groupId}>
          {node.children.map((child) => (
            <FolderRow key={child.path} node={child} depth={depth + 1} {...rest} />
          ))}
          {node.pending.map((item) => <PendingRow key={item.path} item={item} depth={depth + 1} />)}
          {node.papers.map((paper) => (
            <PaperRow key={paper.id} paper={paper} depth={depth + 1} collections={rest.collections} onTagSelect={rest.onTagSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Renders again only when its folder or the shared props change, or one of the values it selects. */
const FolderRow = memo(FolderRowView);

/** A PDF whose import job has not finished yet: its file name, then its page count once known. */
function PendingRow({ item, depth }: { item: PendingImport; depth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ block: "nearest" }), []);
  return (
    <div
      ref={ref}
      role="treeitem"
      aria-level={depth + 1}
      aria-disabled="true"
      className="flex items-start py-1 border-l-2 border-transparent cursor-default text-muted-foreground"
      style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: "8px" }}
      title={`${item.name}
追加中…`}
    >
      <Loader2 className="h-4 w-4 mr-2 mt-0.5 animate-spin text-primary shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="truncate leading-5">{item.name}</div>
        <div className="mt-0.5 text-[0.75rem] leading-4 truncate tabular-nums">
          {item.pages ? `${item.pages}ページ · ` : ""}追加中…
        </div>
      </div>
    </div>
  );
}

/**
 * Memoized, with values selected for this paper only: opening a paper renders its row and the one
 * left, and a job's progress events render its paper's row only when what the row shows changes.
 */
const PaperRow = memo(function PaperRow({ paper, depth, collections, onTagSelect }: { paper: PaperData; depth: number; collections: string[]; onTagSelect: (name: string) => void }) {
  const [allTags, setAllTags] = useState(false);
  // A treeitem, not dnd-kit's default button; the row itself starts a drag from the keyboard, not a button in it.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: paper.id, attributes: { role: "treeitem" } });
  const key = paperKey(paper.id);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    setNodeRef(element);
    setActivatorNodeRef(element);
    rowRef.current = element;
  }, [setNodeRef, setActivatorNodeRef]);
  // Open, and selected: the same until several papers are selected, when the open one keeps its mark
  // whether or not it is among them.
  const isActive = useStore((s) => s.activePaperId === paper.id && s.selectedFolder === null);
  const selected = usePaperSelection((s) => s.ids === null ? null : s.ids.has(paper.id)) ?? isActive;
  const draggedAlong = useDragOver((s) => !!s.paperIds?.has(paper.id));
  const jobState = useStore((s) => paperJobState(s.activeJobs, paper.id, TRANSLATION_JOBS));
  const running = jobState !== "idle";
  const translating = jobState === "translating";
  const failure = useJobFailures((s) => s.failures[paper.id]);
  const collection = normalizeCollection(paper.collection_name || "");
  const tabStop = useTreeFocus((s) => s.tabStop === key);
  // After a move with the keyboard, only the row in the folder it moved to takes the focus.
  useFocusRequest(rowRef, useTreeFocus((s) => s.pending?.key === key && (s.pending.folder === undefined || s.pending.folder === collection)));

  const translation = paperTranslationStatus(paper, translating);
  const showProgress = ["partial", "translating", "paused"].includes(translation.status) && translation.pages > 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger role="none">
        <div
          ref={ref}
          id={`paper-row-${paper.id}`}
          {...listeners}
          {...attributes}
          aria-roledescription={undefined}
          aria-level={depth + 1}
          aria-selected={selected}
          aria-current={isActive ? "true" : undefined}
          tabIndex={tabStop ? 0 : -1}
          data-tree-key={key}
          data-drop-collection={collection}
          onFocus={(e) => { if (e.target === e.currentTarget) updateTreeFocus({ focused: key }); }}
          onClick={(e) => {
            // Ctrl toggles the paper in the selection, Shift selects from the anchor (Ctrl+Shift adds
            // that range); a plain click opens it.
            if (e.shiftKey) changeSelection((selection, rows, open) => selectRange(selection, rows, key, open, { add: e.ctrlKey || e.metaKey }));
            else if (e.ctrlKey || e.metaKey) changeSelection((selection, rows, open) => toggleSelection(selection, rows, key, open));
            else openPaper(paper.id, collection);
          }}
          onKeyDown={(e) => {
            // Not while it is dragged with the keyboard, when the keys are the drag's.
            if (isDragging) return;
            if (isDeleteKey(e)) { e.preventDefault(); deletePaperRow(paper.id); return; }
            // Space alone picks it up; Ctrl+Space and the like are left for selecting.
            if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) listeners?.onKeyDown?.(e);
          }}
          className={`flex items-start py-1 cursor-pointer border-l-2 ${FOCUS_RING} ${
            selected ? "bg-accent" : "hover:bg-muted/60"} ${isActive ? "border-primary" : "border-transparent"
          } ${isDragging || draggedAlong ? "opacity-40" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: "8px" }}
          title={`${paperDisplayName(paper)}\nファイル名：${paper.original_name ?? ""}`}
        >
          <FileText className="h-4 w-4 mr-2 mt-0.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="truncate leading-5">{paperDisplayName(paper)}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.75rem] leading-4 text-muted-foreground tabular-nums">
              <PaperStatusBadge status={translation.status} text={translation.text} description={translation.description}
                hasSummary={!!paper.has_article} className="gap-1 [&>span:first-child]:py-0" />
              <span title={translation.description}>{translation.count}</span>
              {showProgress && <div role="progressbar" aria-label="訳文を保存済みのページ" aria-valuemin={0} aria-valuemax={translation.pages}
                aria-valuenow={translation.completed} aria-valuetext={translation.description} title={translation.description}
                className="h-1 w-10 overflow-hidden rounded-full bg-muted-foreground/10">
                <div className={`h-full rounded-full transition-[width] ${translating ? "bg-primary" : "bg-amber-500/60"}`} style={{ width: `${translation.progress}%` }} />
              </div>}
              <span aria-hidden="true">·</span>
              <span>{paper.read_status || "未設定"}</span>
              {running && !translating && <span className="text-primary">· AI処理中</span>}
            </div>
            {!!paper.tags?.length && <div className="mt-1 flex flex-wrap items-center gap-1 [&>span]:leading-4">
              {(allTags ? paper.tags : paper.tags.slice(0, 2)).map(name => <TagChip key={name} name={name} tabIndex={-1} onClick={() => onTagSelect(name)} />)}
              {paper.tags.length > 2 && <button tabIndex={-1} className="rounded px-1 text-[0.75rem] text-muted-foreground hover:bg-muted" title={paper.tags.join("、")}
                onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setAllTags(!allTags); }}>
                {allTags ? "閉じる" : `+${paper.tags.length - 2}`}</button>}
            </div>}
          </div>
          {running && !translating && <Loader2 className="w-3.5 h-3.5 ml-1 mt-0.5 animate-spin text-primary shrink-0" />}
          {failure && <button type="button" className="ml-1 mt-0.5 shrink-0 rounded text-destructive hover:bg-destructive/10"
            title={`${failure.title}（クリックで詳細）`} aria-label={`${failure.title}。詳細を表示`}
            onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); showJobFailure(paper.id); }}>
            <CircleAlert className="w-3.5 h-3.5" aria-hidden="true" /></button>}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <PaperMenu paper={paper} collection={collection} collections={collections} />
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * A paper's context menu: the paper's own items, or, for a paper in a selection of several, what can be
 * done to them all (the menu of a paper outside the selection is that paper's own, and leaves the
 * selection as it is). Rendered only while the menu is open, so that the rows need not follow the selection.
 */
function PaperMenu({ paper, collection, collections }: { paper: PaperData; collection: string; collections: string[] }) {
  const ids = useMemo(() => papersActedOn(usePaperSelection.getState(), useTreeFocus.getState().rows, paper.id), [paper.id]);
  if (ids.length > 1) return <SelectionMenu ids={ids} paperId={paper.id} collections={collections} />;
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Folder className="w-4 h-4 mr-2" /> 分類を変更
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56 max-h-[320px] overflow-y-auto">
          {["", ...collections].map((c) => (
            <ContextMenuCheckboxItem key={c || "(unfiled)"} checked={c === collection} onClick={() => movePaper(paper.id, c)}>
              {c || "未分類"}
            </ContextMenuCheckboxItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => chooseNewCollection(paper.id, collection)}>新しい分類を入力…</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <PaperOrganizeItems paper={paper} />
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => renamePaperFile(paper.id)}>
        <Edit2 className="w-4 h-4 mr-2" /> ファイル名を変更…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => openPaperFile(paper.id, "original.pdf")}>
        <ExternalLink className="w-4 h-4 mr-2" /> 原文PDFを開く
      </ContextMenuItem>
      <ContextMenuItem onClick={() => saveOriginal(paper.id)}>
        <Save className="w-4 h-4 mr-2" /> 原文PDFを名前を付けて保存…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => openPaperFolder(paper.id)}>
        <FolderOpen className="w-4 h-4 mr-2" /> 保存フォルダーを開く
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void copyBibtex([paper.id])}>
        <Copy className="w-4 h-4 mr-2" /> BibTeX をコピー
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => deletePaperRow(paper.id)} className="text-destructive">
        <Trash2 className="w-4 h-4 mr-2" /> ライブラリから削除
      </ContextMenuItem>
    </>
  );
}

/**
 * One paper's reading status and tags, each saved as it is chosen. The tags' list stays open, so that
 * several go on or off in a row; the marks show what was chosen at once, with the changes still being
 * saved over the row as loaded (useShownOrganization).
 */
function PaperOrganizeItems({ paper }: { paper: PaperData }) {
  const { data: tagChoices = NO_COLLECTIONS } = useTagChoices("paper");
  const { data: statuses = NO_COLLECTIONS } = useTagChoices("status");
  const { tags, status } = useShownOrganization(paper.id, paper.tags, paper.read_status ?? "");
  const names = [...new Set([...tagChoices, ...tags])];
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <BookOpen className="w-4 h-4 mr-2" /> 読書状態
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56 max-h-[320px] overflow-y-auto">
          <ContextMenuRadioGroup value={status} onValueChange={(value: string) => {
            if (value !== status) void setPaperReadStatus(paper.id, value);
          }}>
            {!!status && !statuses.includes(status) && <ContextMenuRadioItem value={status} disabled>{status}（削除済み）</ContextMenuRadioItem>}
            {statuses.map((name) => <ContextMenuRadioItem key={name} value={name}>{name}</ContextMenuRadioItem>)}
          </ContextMenuRadioGroup>
          {!statuses.length && <ContextMenuItem disabled>読書状態がありません</ContextMenuItem>}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Tag className="w-4 h-4 mr-2" /> タグ{tags.length ? `（${tags.length}）` : ""}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56 max-h-[320px] overflow-y-auto">
          {names.map((name) => (
            <ContextMenuCheckboxItem key={name} checked={tags.includes(name)} closeOnClick={false}
              onCheckedChange={(checked: boolean) => void tagPaper(paper.id, name, checked)}>
              <span className="min-w-0 break-all">{name}</span>
            </ContextMenuCheckboxItem>
          ))}
          {!names.length && <ContextMenuItem disabled>タグはまだありません</ContextMenuItem>}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => void tagPapersWithNew([paper.id])}>
            <Plus className="w-4 h-4 mr-2" /> 新しいタグを付ける…
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}

/** Moving, tagging, setting the reading status of and deleting the selected papers `ids`. */
function SelectionMenu({ ids, paperId, collections }: { ids: string[]; paperId: string; collections: string[] }) {
  const sortOrder = useStore((s) => s.sortOrder);
  const { data: listed = NO_PAPERS } = usePaperList("", sortOrder);
  const { data: tagChoices = NO_COLLECTIONS } = useTagChoices("paper");
  const { data: statuses = NO_COLLECTIONS } = useTagChoices("status");
  const selected = useMemo(() => {
    const wanted = new Set(ids);
    return listed.filter((p) => wanted.has(p.id));
  }, [ids, listed]);
  // Tags that any of them has, to take off; and every tag, to put on.
  const onSome = [...new Set(selected.flatMap((p) => p.tags ?? []))];
  const tags = [...new Set([...tagChoices, ...onSome])];
  return (
    <>
      <ContextMenuGroup>
        <ContextMenuLabel>{ids.length}件の論文を選択中</ContextMenuLabel>
      </ContextMenuGroup>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Folder className="w-4 h-4 mr-2" /> まとめて分類を変更
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56 max-h-[320px] overflow-y-auto">
          {["", ...collections].map((c) => (
            <ContextMenuItem key={c || "(unfiled)"} onClick={() => void movePapers(ids, c)}>{c || "未分類"}</ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => void movePapersToNewCollection(ids, "")}>新しい分類を入力…</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Tag className="w-4 h-4 mr-2" /> タグを付ける
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56 max-h-[320px] overflow-y-auto">
          {tags.map((name) => (
            <ContextMenuItem key={name} onClick={() => void tagPapers(ids, name, true)}>
              <span className="min-w-0 break-all">{name}</span>
            </ContextMenuItem>
          ))}
          {!tags.length && <ContextMenuItem disabled>タグはまだありません</ContextMenuItem>}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => void tagPapersWithNew(ids)}>
            <Plus className="w-4 h-4 mr-2" /> 新しいタグを付ける…
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={!onSome.length}>
          <Tag className="w-4 h-4 mr-2" /> タグを外す
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56 max-h-[320px] overflow-y-auto">
          {onSome.map((name) => (
            <ContextMenuItem key={name} onClick={() => void tagPapers(ids, name, false)}>
              <span className="min-w-0 break-all">{name}</span>
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <BookOpen className="w-4 h-4 mr-2" /> 読書状態を変更
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56 max-h-[320px] overflow-y-auto">
          {statuses.map((status) => (
            <ContextMenuItem key={status} onClick={() => void setPapersReadStatus(ids, status)}>{status}</ContextMenuItem>
          ))}
          {!statuses.length && <ContextMenuItem disabled>読書状態がありません</ContextMenuItem>}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onClick={() => void copyBibtex(ids)}>
        <Copy className="w-4 h-4 mr-2" /> {ids.length}件の BibTeX をコピー
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => clearSelection(usePaperSelection.getState().anchor)}>
        <X className="w-4 h-4 mr-2" /> 選択を解除
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => deletePaperRow(paperId)} className="text-destructive">
        <Trash2 className="w-4 h-4 mr-2" /> {ids.length}件をライブラリから削除
      </ContextMenuItem>
    </>
  );
}
