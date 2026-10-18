import type { ComponentPropsWithRef, ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, NotebookPen } from "lucide-react";

export const LIBRARY_FOCUS_RING = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:rounded-sm";
type RowProps = ComponentPropsWithRef<"div"> & { level: number; selected?: boolean };

/** Presentation only: the host owns selection, keyboard navigation, menus and drag/drop. */
export function LibraryFolderRowView({ level, selected = false, chosen = selected, expanded, name, count, onToggle,
  className = "", style, ...props }: RowProps & {
  chosen?: boolean; expanded: boolean; name: string; count: number; onToggle(): void;
}) {
  return <div {...props} data-library-row="folder"
    className={`flex items-center h-[1.875rem] cursor-pointer group border-l-2 ${LIBRARY_FOCUS_RING} ${selected ? "bg-accent" : "hover:bg-muted/60"} ${chosen ? "border-primary" : "border-transparent"} ${className}`}
    style={{ paddingLeft: `${(level - 1) * 16 + 6}px`, paddingRight: "8px", ...style }}>
    <button type="button" data-slot="library-disclosure" tabIndex={-1}
      className="w-4 h-4 flex items-center justify-center mr-1 text-muted-foreground shrink-0"
      onClick={e => { e.stopPropagation(); onToggle(); }} aria-label={expanded ? "閉じる" : "開く"}>
      {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
    </button>
    {expanded ? <FolderOpen className="mr-2 h-4 w-4 text-muted-foreground shrink-0" />
      : <Folder className="mr-2 h-4 w-4 text-muted-foreground shrink-0" />}
    <span className="flex-1 truncate">{name}</span>
    <span className="text-[0.75rem] text-muted-foreground tabular-nums ml-2">{count}</span>
  </div>;
}

export function LibraryPaperRowView({ level, selected = false, active = false, expanded = false, expandable = false,
  notebook = false, label, detail, tags, trailing, onToggle, className = "", style, ...props }: RowProps & {
  active?: boolean; expanded?: boolean; expandable?: boolean; notebook?: boolean; label: string;
  detail?: ReactNode; tags?: ReactNode; trailing?: ReactNode; onToggle?(): void;
}) {
  return <div {...props} data-library-row="paper"
    className={`flex items-start py-1 cursor-pointer border-l-2 ${LIBRARY_FOCUS_RING} ${selected ? "bg-accent" : "hover:bg-muted/60"} ${active ? "border-primary" : "border-transparent"} ${className}`}
    style={{ paddingLeft: `${(level - 1) * 16 + 8}px`, paddingRight: "8px", ...style }}>
    {expandable && <button type="button" data-slot="library-disclosure" tabIndex={-1}
      aria-label={expanded ? "持ち物を閉じる" : "持ち物を開く"} aria-expanded={expanded}
      className="mt-0.5 shrink-0 rounded hover:bg-muted" onPointerDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onToggle?.(); }}>
      {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
    </button>}
    {notebook ? <NotebookPen className="h-4 w-4 mr-2 mt-0.5 text-muted-foreground shrink-0" />
      : <FileText className="h-4 w-4 mr-2 mt-0.5 text-muted-foreground shrink-0" />}
    <div className="flex-1 min-w-0">
      <div className="truncate leading-5">{label}</div>
      {detail && <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.75rem] leading-4 text-muted-foreground tabular-nums">{detail}</div>}
      {tags}
    </div>
    {trailing}
  </div>;
}

export function LibraryChildRowView({ level, selected = false, kind, label, className = "", style, ...props }: RowProps & {
  kind: "owned" | "attachment" | "html" | "link" | "more"; label: string;
}) {
  return <div {...props} data-library-row="child"
    className={`flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-[0.75rem] leading-5 text-muted-foreground ${selected ? "bg-accent" : "hover:bg-muted/60"} ${LIBRARY_FOCUS_RING} ${className}`}
    style={{ paddingLeft: `${(level - 1) * 16 + 8}px`, ...style }}>
    {kind === "link" ? <span aria-hidden="true">↗</span> : kind === "owned" ? <NotebookPen className="size-3 shrink-0" />
      : kind === "html" ? <span aria-hidden="true">🌐</span> : kind !== "more" && <FileText className="size-3 shrink-0" />}
    <span className="truncate">{label}</span>
  </div>;
}
