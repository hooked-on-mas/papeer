import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { summarySelection, type SummaryChoice, type SummaryPlan } from "./summaryStart";

export function SummaryScopeForm({ plan, choice, onChange, onFinish }: {
  plan: SummaryPlan; choice: SummaryChoice; onChange: (choice: SummaryChoice) => void; onFinish: (pages: string | null) => void;
}) {
  const selection = summarySelection(plan, choice);
  return (
    <form className="grid min-h-0 gap-3" onSubmit={(event) => { event.preventDefault(); if (!selection.error) onFinish(selection.pages); }}>
      <DialogDescription className="text-xs">
        {plan.requires_selection ? "長い資料のため、要約する範囲を選んでください。" : "必要に応じて、要約する範囲を変更できます。"}
      </DialogDescription>
      <div className="grid gap-2">
        <label htmlFor="summary-scope" className="text-[0.8125rem] font-medium">サマリーの対象</label>
        <NativeSelect id="summary-scope" value={choice.scope} onChange={(event) => onChange({ ...choice, scope: event.target.value as SummaryChoice["scope"] })}>
          <option value="all">全ページ（{plan.page_count}ページ）</option>
          {plan.chapters.length > 0 && <option value="chapters">章を選ぶ</option>}
          <option value="custom">ページ範囲を指定</option>
        </NativeSelect>
      </div>
      {choice.scope === "chapters" && (
        <fieldset className="grid gap-2 min-h-0">
          <legend className="text-[0.8125rem] mb-2">要約する章（複数選択可）</legend>
          <div className="max-h-40 overflow-y-auto rounded border p-2 grid gap-1">
            {plan.chapters.map((chapter, index) => (
              <label key={index} className="flex items-start gap-2 text-[0.8125rem] p-1 hover:bg-muted" style={{ paddingLeft: `${Math.min(chapter.depth, 5) * 12 + 4}px` }}>
                <input type="checkbox" className="mt-1 shrink-0" checked={choice.chapters.includes(index)} onChange={(event) => onChange({
                  ...choice, chapters: event.target.checked ? [...choice.chapters, index] : choice.chapters.filter((value) => value !== index),
                })} />
                <span className="min-w-0 break-words">{chapter.title} <span className="text-muted-foreground">（p.{chapter.start_page}–{chapter.end_page}）</span></span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">選んだ章をまとめて1つのサマリーにします。章の境界はページ単位のため、隣の章の一部を含む場合があります。</p>
        </fieldset>
      )}
      {choice.scope === "custom" && (
        <div className="grid gap-2">
          {!plan.chapters.length && <p className="text-xs text-muted-foreground">PDFに目次が見つかりません。ページ範囲で指定できます。</p>}
          <label htmlFor="summary-pages" className="text-[0.8125rem]">ページ番号（PDFの先頭を1ページとして指定）</label>
          <Input id="summary-pages" placeholder="例: 1, 3-5, 8" value={choice.customRange} onChange={(event) => onChange({ ...choice, customRange: event.target.value })} />
        </div>
      )}
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {selection.error || `対象：${selection.count} / ${plan.page_count}ページ`}
      </p>
      {!selection.error && selection.count >= 30 && (
        <p className="text-xs text-muted-foreground">ページを絞るとAIの利用量を抑えられます。</p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onFinish(null)}>キャンセル</Button>
        <Button type="submit" disabled={!!selection.error}>{choice.scope === "all" ? "全文で作成する" : "選択範囲で作成する"}</Button>
      </DialogFooter>
    </form>
  );
}
