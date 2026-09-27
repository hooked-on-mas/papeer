import { useTagChoices } from "@/api/tagChoices";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
  ArrowUpDown, ChevronDown, ChevronRight, Edit2, ExternalLink, FilePlus2, FileText, Folder, FolderOpen,
  FolderPlus, Loader2, Save, Search, Trash2, Undo2, X,
} from "lucide-react";
import { paperDisplayName, useCollections, usePaperList, type PaperData } from "@/api/hooks";
import { isRunning, useStore } from "@/store";
import {
  ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub,
  ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  chooseNewCollection, createFolder, deleteFolder, deletePaper, importPdfs, movePaper, normalizeCollection,
  openPaperFile, openPaperFolder, renameFolder, renamePaperFile, saveOriginal, undoMove,
} from "@/app/actions";
import { useDropTarget } from "@/app/fileDrop";
import { usePendingImports, type PendingImport } from "@/app/pendingImports";
import { LibraryTags } from "./LibraryTags";
import { TagChip } from "@/components/ui/TagChip";
import { PaperStatusBadge } from "@/components/ui/PaperStatusBadge";
import { paperTranslationStatus } from "@/lib/paperStatus";
import { isJobKind, TRANSLATION_JOBS } from "@/features/jobs/jobKinds";
import { onAppEvent } from "@/lib/appEvents";
import { QK } from "@/lib/queryKeys";

export const SORT_LABELS = ["追加が新しい順", "追加が古い順", "名前順（昇順）", "名前順（降順）"];
type LibraryHit = { paper_id: string; title: string; side: "metadata" | "note" | "original" | "translated"; page: number | null; snippet: string };

type FolderNode = {
  path: string;
  name: string;
  children: FolderNode[];
  papers: PaperData[];
  pending: PendingImport[];
  count: number;
};

function buildTree(collections: string[], papers: PaperData[], pending: PendingImport[], filtered: boolean): FolderNode[] {
  const grouped = new Map<string, PaperData[]>();
  for (const paper of papers) {
    const path = normalizeCollection(paper.collection_name || "");
    grouped.set(path, [...(grouped.get(path) ?? []), paper]);
  }
  const pendingGroups = new Map<string, PendingImport[]>();
  for (const item of pending) pendingGroups.set(item.collection, [...(pendingGroups.get(item.collection) ?? []), item]);
  // While searching only folders with matches are listed, as in the old tree.
  // PDFs being added are always shown, so a drop never seems to have been ignored.
  const paths = new Set<string>([...grouped.keys(), ...pendingGroups.keys()].filter(Boolean));
  if (!filtered) collections.forEach((c) => paths.add(c));
  for (const path of [...paths]) {
    const parts = path.split(" / ");
    for (let depth = 1; depth < parts.length; depth++) paths.add(parts.slice(0, depth).join(" / "));
  }
  const nodes = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];
  const ordered = [...paths].sort((a, b) =>
    a.split(" / ").length - b.split(" / ").length || a.localeCompare(b, "ja", { sensitivity: "base" }));
  for (const path of ordered) {
    const parts = path.split(" / ");
    const node: FolderNode = {
      path, name: parts[parts.length - 1], children: [], papers: grouped.get(path) ?? [],
      pending: pendingGroups.get(path) ?? [], count: 0,
    };
    nodes.set(path, node);
    const parent = nodes.get(parts.slice(0, -1).join(" / "));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const count = (node: FolderNode): number =>
    (node.count = node.papers.length + node.pending.length + node.children.reduce((sum, child) => sum + count(child), 0));
  roots.forEach(count);
  if (!filtered || grouped.has("") || pendingGroups.has("")) {
    const unfiled: FolderNode = {
      path: "", name: "未分類", children: [], papers: grouped.get("") ?? [], pending: pendingGroups.get("") ?? [], count: 0,
    };
    unfiled.count = unfiled.papers.length + unfiled.pending.length;
    roots.push(unfiled);
  }
  return roots;
}

function allFolderPaths(nodes: FolderNode[]): string[] {
  return nodes.flatMap((n) => [n.path, ...allFolderPaths(n.children)]);
}

export function LibrarySidebar() {
  const undoHistory = useStore((s) => s.moveHistory);
  const lastUndo = undoHistory[undoHistory.length - 1];
  const undoLabel = lastUndo && "kind" in lastUndo ? `「${lastUndo.path}」の削除を元に戻す` : "論文の移動を元に戻す";
  const { data: readingStatuses = [] } = useTagChoices("status");
  const librarySearch = useStore((s) => s.librarySearch);
  const setLibrarySearch = useStore((s) => s.setLibrarySearch);
  const sortOrder = useStore((s) => s.sortOrder);
  const setSortOrder = useStore((s) => s.setSortOrder);
  const currentCollection = useStore((s) => s.currentCollection);
  const expandedCollections = useStore((s) => s.expandedCollections);
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
  const { data: allPapers = [], isSuccess: papersLoaded } = usePaperList("", sortOrder);
  useEffect(() => {
    if (papersLoaded && tagFilter && !allPapers.some(paper => paper.tags?.includes(tagFilter))) setTagFilter("");
  }, [allPapers, papersLoaded, tagFilter]);
  const { data: searchResults, isFetching: searching, isError: searchError } = useQuery({
    queryKey: [QK.librarySearch, librarySearch],
    queryFn: () => apiRequest<{ results: LibraryHit[]; limited: boolean }>("GET", `/api/library-search?q=${encodeURIComponent(librarySearch)}`),
    enabled: !!librarySearch.trim(),
  });
  const papers = allPapers.filter(p => (!tagFilter || p.tags?.includes(tagFilter)) && (!readFilter || p.read_status === readFilter)
    && (!librarySearch.trim() || searchResults?.results.some(hit => hit.paper_id === p.id)));
  const hits = searchResults?.results.filter(hit => papers.some(p => p.id === hit.paper_id)) ?? [];
  const { data: collections = [] } = useCollections();
  const pending = usePendingImports((s) => s.items);
  const tree = useMemo(() => buildTree(collections, papers, pending, filtered), [collections, papers, pending, filtered]);

  const isExpanded = (path: string) => filtered || expandedCollections === null || expandedCollections.includes(path);
  const setExpanded = (path: string, expanded: boolean) => {
    const current = new Set(expandedCollections ?? allFolderPaths(tree));
    if (expanded) current.add(path);
    else current.delete(path);
    setExpandedCollections([...current]);
  };

  const [dragging, setDragging] = useState<PaperData | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = (event: DragStartEvent) => setDragging(papers.find((p) => p.id === event.active.id) ?? null);
  const onDragOver = (event: DragOverEvent) => {
    const target = event.over ? String(event.over.id).replace(/^folder:/, "") : null;
    if (target === dragOver) return;
    setDragOver(target);
    clearTimeout(hoverTimer.current);
    // Hovering a closed folder opens it, so papers can be dropped into subfolders.
    if (target !== null) hoverTimer.current = setTimeout(() => setExpanded(target, true), 700);
  };
  const onDragEnd = (event: DragEndEvent) => {
    clearTimeout(hoverTimer.current);
    setDragging(null);
    setDragOver(null);
    if (!event.over) return;
    movePaper(String(event.active.id), String(event.over.id).replace(/^folder:/, ""));
  };

  useEffect(() => {
    // Ctrl+L and citations reveal the paper: open its ancestors and scroll to it.
    return onAppEvent("reveal-paper", ({ paperId, focus }) => {
      const paper = papers.find((p) => p.id === paperId);
      if (paper && expandedCollections !== null) {
        const parts = normalizeCollection(paper.collection_name || "").split(" / ").filter(Boolean);
        const next = new Set(expandedCollections);
        parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join(" / ")));
        if (!parts.length) next.add("");
        if (next.size !== expandedCollections.length) setExpandedCollections([...next]);
      }
      setTimeout(() => {
        const row = document.getElementById(`paper-row-${paperId}`);
        row?.scrollIntoView({ block: "nearest" });
        if (focus) row?.focus();
      }, 50);
    });
  }, [papers, expandedCollections, setExpandedCollections]);

  const clearFilters = () => {
    setSearchText("");
    setLibrarySearch("");
    setTagFilter(""); setReadFilter("");
  };

  return (
    <div className="flex flex-col h-full text-[13px] select-none" onKeyDown={(event) => {
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
          className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground h-[32px] rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <FilePlus2 className="w-4 h-4" />
          PDF を追加
        </button>
        <div className="text-[12px] text-muted-foreground truncate px-0.5" title={currentCollection || "未分類"}>
          追加先：{currentCollection || "未分類"}
        </div>
        <button onClick={undoMove} disabled={!lastUndo} title={`${undoLabel}（ライブラリ内で Ctrl+Z）`}
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
              className="w-full h-[32px] pl-8 pr-7 rounded-md bg-background border text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
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
              className="w-[32px] h-[32px] flex items-center justify-center border rounded-md hover:bg-muted shrink-0"
              title={`並べ替え：${SORT_LABELS[sortOrder]}`}
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
            className="w-[32px] h-[32px] flex items-center justify-center border rounded-md hover:bg-muted shrink-0"
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

      <DndContext sensors={sensors} collisionDetection={pointerWithin}
        onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}
        onDragCancel={() => { setDragging(null); setDragOver(null); }}>
        <div
          className="flex-1 overflow-auto py-1 outline-none"
          tabIndex={-1}
          title="右クリックで名前変更・子フォルダー作成。論文をドラッグしてフォルダーへ移動（F2：名前変更、Delete：削除）"
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
          {!librarySearch.trim() && tree.map((node) => (
            <FolderRow key={node.path || "(unfiled)"} node={node} depth={0} papers={papers} collections={collections}
              isExpanded={isExpanded} setExpanded={setExpanded} dragOver={dragOver} onTagSelect={setTagFilter} />
          ))}
          {papers.length === 0 && pending.length === 0 && (
            <div className="px-4 py-6 text-center text-muted-foreground text-[12px] leading-relaxed">
              {filtered
                ? "見つかりませんでした。検索語や絞り込みを変更してください。"
                : "PDFを追加するか、フォルダーへドロップして読み始めましょう。"}
            </div>
          )}
          {filtered && (
            <div className="px-2 py-1">
              <button onClick={clearFilters} className="w-full h-7 rounded-md border text-[12px] hover:bg-muted">
                検索・絞り込みを解除
              </button>
            </div>
          )}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging && (
            <div className="px-3 py-1.5 rounded-md bg-card border shadow-md text-[13px] max-w-[260px] truncate">
              {paperDisplayName(dragging)}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <div className="px-3 py-1.5 text-[12px] text-muted-foreground border-t shrink-0 tabular-nums">
        {papers.length} 件の論文
      </div>
    </div>
  );
}

/** Delete on the focused row itself, not on a nested button such as the tag toggle. */
const isDeleteKey = (e: KeyboardEvent<HTMLElement>) => (e.key === "Delete" || e.key === "Backspace") && e.target === e.currentTarget;

type RowProps = {
  onTagSelect: (name: string) => void;
  papers: PaperData[];
  collections: string[];
  isExpanded: (path: string) => boolean;
  setExpanded: (path: string, expanded: boolean) => void;
  dragOver: string | null;
};

function FolderRow({ node, depth, ...rest }: { node: FolderNode; depth: number } & RowProps) {
  const { papers, isExpanded, setExpanded, dragOver } = rest;
  const { setNodeRef } = useDroppable({ id: `folder:${node.path}` });
  const selectedFolder = useStore((s) => s.selectedFolder);
  const osDropTarget = useDropTarget((s) => s.target);
  const expanded = isExpanded(node.path);
  const selected = selectedFolder === node.path;
  const highlighted = dragOver === node.path || osDropTarget === node.path;

  const select = () => {
    useStore.getState().setSelectedFolder(node.path);
    useStore.getState().setCurrentCollection(node.path);
  };

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger>
          <div
            ref={setNodeRef}
            data-drop-collection={node.path}
            className={`flex items-center h-[30px] cursor-pointer group border-l-2 outline-none ${
              selected ? "bg-accent border-primary" : "border-transparent hover:bg-muted/60"
            } ${highlighted ? "outline-2 outline-primary -outline-offset-2 rounded-sm" : ""}`}
            style={{ paddingLeft: `${depth * 16 + 6}px`, paddingRight: "8px" }}
            tabIndex={0}
            onClick={select}
            onDoubleClick={() => setExpanded(node.path, !expanded)}
            onKeyDown={(e) => { if (node.path && isDeleteKey(e)) { e.preventDefault(); void deleteFolder(node.path, papers); } }}
            title={node.path || "フォルダー未指定のPDF"}
          >
            <button
              className="w-4 h-4 flex items-center justify-center mr-1 text-muted-foreground shrink-0"
              onClick={(e) => { e.stopPropagation(); setExpanded(node.path, !expanded); }}
              aria-label={expanded ? "閉じる" : "開く"}
            >
              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            {expanded ? <FolderOpen className="mr-2 h-4 w-4 text-muted-foreground shrink-0" />
              : <Folder className="mr-2 h-4 w-4 text-muted-foreground shrink-0" />}
            <span className="flex-1 truncate">{node.name}</span>
            <span className="text-[11px] text-muted-foreground tabular-nums ml-2">{node.count}</span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => createFolder(node.path)}>
            <FolderPlus className="w-4 h-4 mr-2" /> {node.path ? "子フォルダーを作成…" : "フォルダーを作成…"}
          </ContextMenuItem>
          {node.path && (
            <>
              <ContextMenuItem onClick={() => renameFolder(node.path)}>
                <Edit2 className="w-4 h-4 mr-2" /> 名前を変更…
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => deleteFolder(node.path, papers)} className="text-destructive">
                <Trash2 className="w-4 h-4 mr-2" /> フォルダーを削除
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {expanded && (
        <div>
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

/** A PDF whose import job has not finished yet: its file name, then its page count once known. */
function PendingRow({ item, depth }: { item: PendingImport; depth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ block: "nearest" }), []);
  return (
    <div
      ref={ref}
      className="flex items-start py-1 border-l-2 border-transparent cursor-default text-muted-foreground"
      style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: "8px" }}
      title={`${item.name}
追加中…`}
    >
      <Loader2 className="h-4 w-4 mr-2 mt-0.5 animate-spin text-primary shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="truncate leading-5">{item.name}</div>
        <div className="mt-0.5 text-[10px] leading-4 truncate tabular-nums">
          {item.pages ? `${item.pages}ページ · ` : ""}追加中…
        </div>
      </div>
    </div>
  );
}

function PaperRow({ paper, depth, collections, onTagSelect }: { paper: PaperData; depth: number; collections: string[]; onTagSelect: (name: string) => void }) {
  const [allTags, setAllTags] = useState(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: paper.id });
  const activePaperId = useStore((s) => s.activePaperId);
  const selectedFolder = useStore((s) => s.selectedFolder);
  const jobs = useStore((s) => s.activeJobs);
  const running = jobs.some((j) => isRunning(j) && j.paper_id === paper.id);
  const translating = jobs.some(j => isRunning(j) && j.paper_id === paper.id && isJobKind(j.kind, TRANSLATION_JOBS));
  const isActive = paper.id === activePaperId && selectedFolder === null;
  const collection = normalizeCollection(paper.collection_name || "");

  const select = () => {
    const store = useStore.getState();
    store.setSelectedFolder(null);
    store.setCurrentCollection(collection);
    if (store.activePaperId !== paper.id) store.setActivePaperId(paper.id);
  };

  const translation = paperTranslationStatus(paper, translating);
  const showProgress = ["partial", "translating", "paused"].includes(translation.status) && translation.pages > 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          ref={setNodeRef}
          id={`paper-row-${paper.id}`}
          {...listeners}
          {...attributes}
          data-drop-collection={collection}
          onClick={select}
          onKeyDown={(e) => { if (isDeleteKey(e)) { e.preventDefault(); void deletePaper(paper.id); } }}
          className={`flex items-start py-1 cursor-pointer border-l-2 outline-none ${
            isActive ? "bg-accent border-primary" : "hover:bg-muted/60 border-transparent"
          } ${isDragging ? "opacity-40" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: "8px" }}
          title={`${paperDisplayName(paper)}\nファイル名：${paper.original_name ?? ""}`}
        >
          <FileText className="h-4 w-4 mr-2 mt-0.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="truncate leading-5">{paperDisplayName(paper)}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] leading-4 text-muted-foreground tabular-nums">
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
              {(allTags ? paper.tags : paper.tags.slice(0, 2)).map(name => <TagChip key={name} name={name} onClick={() => onTagSelect(name)} />)}
              {paper.tags.length > 2 && <button className="rounded px-1 text-[10px] text-muted-foreground hover:bg-muted" title={paper.tags.join("、")}
                onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setAllTags(!allTags); }}>
                {allTags ? "閉じる" : `+${paper.tags.length - 2}`}</button>}
            </div>}
          </div>
          {running && !translating && <Loader2 className="w-3.5 h-3.5 ml-1 mt-0.5 animate-spin text-primary shrink-0" />}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
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
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => deletePaper(paper.id)} className="text-destructive">
          <Trash2 className="w-4 h-4 mr-2" /> ライブラリから削除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
