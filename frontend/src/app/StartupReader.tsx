import { useStore } from "@/store";

/** Keep the reader's room while the previous paper and reading place are being restored. */
export function StartupReader() {
  const readerSplit = useStore((s) => s.readerSplit);
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-reader-bg" aria-busy="true">
      <div className="h-[2.4375rem] shrink-0 border-b bg-background/50 px-3 flex items-center gap-4">
        <div aria-hidden="true" className="h-5 w-24 shrink-0 rounded bg-muted" />
        <p role="status" className="text-[0.75rem] text-muted-foreground truncate">読書画面を準備しています…</p>
      </div>
      <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: `minmax(0, ${readerSplit}fr) 4px minmax(0, ${1 - readerSplit}fr)` }}>
        {["原文", "日本語訳"].map((caption, index) => (
          <div key={caption} className="contents">
            {index === 1 && <div aria-hidden="true" className="bg-border" />}
            <div role="region" aria-label={caption} className="relative flex min-h-0 min-w-0 p-4 pt-6">
              <span className="absolute left-1 top-0.5 rounded bg-background/80 px-1.5 text-[0.75rem] font-medium text-muted-foreground">{caption}</span>
              <div aria-hidden="true" className="flex-1 min-w-0 w-full max-w-xl mx-auto rounded border bg-background/60" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
