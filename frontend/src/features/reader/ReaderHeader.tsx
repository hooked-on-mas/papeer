import type { ReactNode } from "react";
import { PenLine } from "lucide-react";
import { useStore } from "@/store";
import { useInkTools } from "./useInkEditor";
import { inkToolbarOpen } from "./readerBars";

/** The shared PDF heading keeps the writing entry visible, separate from display controls. */
export function ReaderHeader({ caption, badge }: { caption: string; badge?: ReactNode }) {
  const open = useStore((s) => s.inkBarOpen);
  const tool = useInkTools((s) => s.tool);
  const listOpen = useInkTools((s) => s.listOpen);
  const pressed = inkToolbarOpen({ open, tool, listOpen });
  const toggle = () => {
    if (pressed) {
      useStore.getState().setInkBarOpen(false);
      useInkTools.getState().setListOpen(false);
      useInkTools.getState().setTool("select");
    } else {
      useStore.getState().setInkBarOpen(true);
    }
  };

  return (
    <div data-reader-header="" className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 shrink-0 border-b bg-background px-3 py-1.5">
      <span className="min-w-0 truncate text-[0.75rem] font-medium text-muted-foreground">原文</span>
      <button type="button" onClick={toggle} aria-label="書き込みツール" aria-pressed={pressed}
        aria-controls="reader-ink-tools"
        title={pressed ? "書き込みツールを閉じて本文選択に戻る" : "書き込みツールを表示（ペン・消しゴム・付箋・範囲キャプチャ・書き込み付きPDFの保存）"}
        className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-[0.8125rem] font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${pressed ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-primary/35 bg-primary/10 text-primary hover:bg-primary/20"}`}>
        <PenLine className="size-4" aria-hidden="true" />
        書き込み
      </button>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-[0.75rem]">
        <span className="min-w-0 truncate font-medium text-muted-foreground" title={caption}>{caption}</span>
        {badge}
      </div>
    </div>
  );
}
