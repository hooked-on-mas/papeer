import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Folder, Search, X } from "lucide-react";
import { LibraryChildRowView, LibraryFolderRowView, LibraryPaperRowView } from "../features/library/LibraryRows";
import { folderAncestors } from "../lib/collectionPath";
import type { DriveLibraryRuntime } from "./libraryRuntime";
import { buildWebLibraryTree, type WebLibraryChild, type WebLibraryEntry, type WebLibraryFolder } from "./librarySidebarTree";

type Line = { key: string; parent?: string; level: number } & (
  { kind: "folder"; folder: WebLibraryFolder; open: boolean }
  | { kind: "paper"; entry: WebLibraryEntry; open: boolean }
  | { kind: "child"; child: WebLibraryChild; owner: string }
);

/** Same row presentation as desktop; this host supplies only browsing and saved metadata search. */
export function WebLibrarySidebar({ runtime, selectedItemId, selectedArtifactId, onSelectItem, onSelectArtifact, onAllFiles }: {
  runtime: DriveLibraryRuntime; selectedItemId: string; selectedArtifactId?: string;
  onSelectItem(id: string): void; onSelectArtifact(itemId: string, artifactId: string): void; onAllFiles?(): void;
}) {
  const items = runtime.query.listItems();
  // Query per item so internal review history stays out of the normal library browser.
  const artifacts = useMemo(() => items.flatMap(item => runtime.query.listReadingMaterials(item.id)), [items, runtime]);
  const [query, setQuery] = useState("");
  const [closedFolders, setClosedFolders] = useState<Set<string>>(() => new Set());
  const [openPapers, setOpenPapers] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState("");
  const refs = useRef(new Map<string, HTMLDivElement>());
  const tree = useMemo(() => buildWebLibraryTree(items, artifacts, query), [items, artifacts, query]);
  const searching = !!query.trim();
  useEffect(() => {
    const item = items.find(row => row.id === selectedItemId);
    if (!item) return;
    const owner = items.find(row => row.id === item.parentId);
    const paths = folderAncestors((owner ?? item).collectionName);
    setClosedFolders(before => { const next = new Set(before); for (const path of paths.length ? paths : [""]) next.delete(path); return next; });
    if (owner || selectedArtifactId) setOpenPapers(before => new Set(before).add(owner?.id ?? item.id));
  }, [items, selectedItemId, selectedArtifactId]);
  const lines: Line[] = [];
  const visit = (folders: WebLibraryFolder[], level: number, parent?: string) => {
    for (const folder of folders) {
      const key = `folder:${folder.path}`, open = searching || !closedFolders.has(folder.path);
      lines.push({ kind: "folder", key, parent, level, folder, open });
      if (!open) continue;
      visit(folder.children, level + 1, key);
      for (const entry of folder.entries) {
        const paperKey = `paper:${entry.item.id}`, paperOpen = searching || openPapers.has(entry.item.id);
        lines.push({ kind: "paper", key: paperKey, parent: key, level: level + 1, entry, open: paperOpen });
        if (paperOpen) for (const child of entry.children) lines.push({ kind: "child", key: child.kind === "owned" ? `paper:${child.item.id}` : `artifact:${child.artifact.id}`,
          parent: paperKey, level: level + 2, child, owner: entry.item.id });
      }
    }
  };
  visit(tree, 1);
  const selectedKey = selectedArtifactId ? `artifact:${selectedArtifactId}` : `paper:${selectedItemId}`;
  const tabStop = lines.some(line => line.key === focused) ? focused : lines.some(line => line.key === selectedKey) ? selectedKey : lines[0]?.key;
  const toggle = (line: Line, open?: boolean) => {
    if (line.kind === "folder") setClosedFolders(before => {
      const next = new Set(before); if (open ?? !line.open) next.delete(line.folder.path); else next.add(line.folder.path); return next;
    });
    if (line.kind === "paper") setOpenPapers(before => {
      const next = new Set(before); if (open ?? !line.open) next.add(line.entry.item.id); else next.delete(line.entry.item.id); return next;
    });
  };
  const activate = (line: Line) => {
    if (line.kind === "folder") toggle(line);
    else if (line.kind === "paper") onSelectItem(line.entry.item.id);
    else if (line.child.kind === "owned") onSelectItem(line.child.item.id);
    else onSelectArtifact(line.owner, line.child.artifact.id);
  };
  const focus = (key?: string) => { if (key) { setFocused(key); refs.current.get(key)?.focus(); } };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>, line: Line) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const index = lines.indexOf(line);
    if (event.key === "ArrowDown") focus(lines[Math.min(index + 1, lines.length - 1)]?.key);
    else if (event.key === "ArrowUp") focus(lines[Math.max(0, index - 1)]?.key);
    else if (event.key === "Home") focus(lines[0]?.key);
    else if (event.key === "End") focus(lines[lines.length - 1]?.key);
    else if (event.key === "ArrowRight") {
      if (line.kind !== "child" && !line.open) toggle(line, true);
      else if (lines[index + 1]?.parent === line.key) focus(lines[index + 1].key);
    } else if (event.key === "ArrowLeft") {
      if (line.kind !== "child" && line.open) toggle(line, false); else focus(line.parent);
    } else if (event.key === "Enter" || event.key === " ") activate(line);
    else return;
    event.preventDefault(); event.stopPropagation();
  };
  return <div data-web-library-sidebar className="flex flex-col h-full min-h-0 text-[0.8125rem] select-none">
    <div className="p-2 shrink-0"><div className="relative">
      <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <input aria-label="ライブラリを検索" placeholder="タイトル・メモ名を検索" title="保存されたタイトル・著者・フォルダー名・メモ名を検索"
        className="w-full h-8 pl-8 pr-7 rounded-md bg-background border text-[0.8125rem] focus:outline-none focus:ring-2 focus:ring-ring"
        value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) setQuery(""); }} />
      {query && <button type="button" data-slot="library-search-clear" aria-label="検索を解除" onClick={() => setQuery("")}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>}
    </div></div>
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div role="tree" aria-label="ライブラリ" className="py-1">
        {lines.map(line => {
          const common = { ref: (element: HTMLDivElement | null) => { if (element) refs.current.set(line.key, element); else refs.current.delete(line.key); },
            role: "treeitem", "aria-level": line.level, "data-tree-key": line.key, level: line.level, tabIndex: line.key === tabStop ? 0 : -1,
            onFocus: () => setFocused(line.key), onClick: () => activate(line), onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => keyDown(event, line) };
          if (line.kind === "folder") return <LibraryFolderRowView key={line.key} {...common} name={line.folder.name} count={line.folder.count}
            title={line.folder.path || "未分類"} aria-label={`${line.folder.name}（${line.folder.count}件）`} expanded={line.open} aria-expanded={line.open}
            onToggle={() => toggle(line)} />;
          if (line.kind === "paper") {
            const { item, children } = line.entry;
            return <LibraryPaperRowView key={line.key} {...common} label={item.displayTitle} title={item.title} aria-label={item.displayTitle}
              notebook={item.kind === "notebook"} selected={selectedItemId === item.id && !selectedArtifactId} active={selectedItemId === item.id}
              aria-selected={selectedItemId === item.id && !selectedArtifactId} aria-current={selectedItemId === item.id ? "true" : undefined}
              expandable={children.length > 0} expanded={line.open} aria-expanded={children.length ? line.open : undefined} onToggle={() => toggle(line)}
              detail={<span>{item.kind === "notebook" ? "ノート" : "PDF"}</span>}
              trailing={children.length > 0 && <span className="ml-1 mt-0.5 text-xs text-muted-foreground" aria-label={`持ち物 ${children.length}件`}>{children.length}</span>} />;
          }
          const child = line.child;
          const label = child.kind === "owned" ? child.item.displayTitle : child.artifact.label;
          const selected = line.key === selectedKey;
          return <LibraryChildRowView key={line.key} {...common} kind={child.kind === "owned" ? "owned" : child.artifact.filename.endsWith(".html") ? "html" : "attachment"}
            label={label} title={child.kind === "owned" ? child.item.title : label} aria-label={label} selected={selected} aria-selected={selected} aria-current={selected ? "true" : undefined} />;
        })}
      </div>
      {!lines.length && <p className="px-4 py-6 text-center text-muted-foreground text-[0.75rem]">{searching ? "該当する項目はありません。" : "保存された項目はありません。"}</p>}
    </div>
    <div className="px-3 py-1.5 text-[0.75rem] text-muted-foreground border-t shrink-0 tabular-nums">{items.length} 件</div>
    {onAllFiles && <button type="button" data-slot="library-all-files" className="flex items-center gap-2 px-3 py-2 border-t text-left hover:bg-muted/60"
      onClick={onAllFiles}><Folder className="size-4" />ライブラリ全体のファイル</button>}
  </div>;
}
