import type { ReactNode } from "react";

/** Shared compact editor, either floating on a PDF or embedded in a dialog. */
export function AnnotationTextEditor({ value, onChange, onSave, onCancel, label, controls, busy = false, allowEmpty = false, maxLength = 2000, error, embedded = false }: {
  value: string; onChange: (value: string) => void; onSave: () => void; onCancel: () => void;
  label: string; controls?: ReactNode; busy?: boolean; allowEmpty?: boolean; maxLength?: number; error?: string; embedded?: boolean;
}) {
  return <div className={embedded ? "w-full min-w-0 max-w-full text-foreground" : "w-64 min-w-0 max-w-full rounded-lg border bg-background p-2 shadow-lg pointer-events-auto text-foreground"}
    role={embedded ? undefined : "dialog"} aria-label={embedded ? undefined : label} onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
    onKeyDown={e => {
      e.stopPropagation();
      if (busy || e.nativeEvent.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && (allowEmpty || value.trim())) { e.preventDefault(); onSave(); }
    }}>
    {controls && <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2 text-xs">{controls}</div>}
    <textarea autoFocus aria-label={label} wrap="soft" className="block w-full min-w-0 max-w-full h-24 resize-y bg-background border rounded p-2 text-sm"
      placeholder="メモを入力…" maxLength={maxLength} value={value} disabled={busy} onChange={e => onChange(e.target.value)} />
    {error && <p role="alert" className="text-xs text-destructive my-1 [overflow-wrap:anywhere]">{error}</p>}
    <div className="flex flex-wrap gap-2 justify-end text-xs mt-1">
      <button disabled={busy} onClick={onCancel}>キャンセル</button>
      <button className="rounded bg-primary text-primary-foreground px-2 py-1 disabled:opacity-40" disabled={busy || (!allowEmpty && !value.trim())} onClick={onSave}>{busy ? "保存中…" : "確定"}</button>
    </div>
  </div>;
}
