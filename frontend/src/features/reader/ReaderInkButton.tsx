import { PenLine } from "lucide-react";
import { useStore } from "@/store";
import { useInkTools } from "./useInkEditor";
import { inkToolbarOpen } from "./readerBars";

/** A labeled writing entry that stays immediately before the table of contents. */
export function ReaderInkButton() {
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
      <button type="button" onClick={toggle} aria-label="書き込みツール" aria-pressed={pressed}
        aria-controls="reader-ink-tools"
        title={pressed ? "書き込みツールを閉じて本文選択に戻る" : "書き込みツールを表示（ペン・消しゴム・付箋・範囲キャプチャ・書き込み付きPDFの保存）"}
        className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border px-3 text-[0.8125rem] font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${pressed ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-primary/35 bg-primary/10 text-primary hover:bg-primary/20"}`}>
        <PenLine className="size-4" aria-hidden="true" />
        書き込み
      </button>
  );
}
