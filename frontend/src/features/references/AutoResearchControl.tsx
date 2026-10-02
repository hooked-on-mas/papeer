import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setAutoResearch, type useAutomaticResearch } from "./autoResearch";

export function AutoResearchControl({ state }: { state: ReturnType<typeof useAutomaticResearch> }) {
  return <div className="border-b px-5 py-3 space-y-1.5 bg-muted/20">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label className="inline-flex items-center gap-2 text-sm font-medium cursor-pointer">
        <input type="checkbox" className="accent-primary" checked={state.enabled}
          onChange={event => setAutoResearch(event.target.checked)} />AIで情報収集
      </label>
      {state.enabled && <span className="text-xs text-muted-foreground" role="status">取得済み {state.completed} / {state.total}</span>}
    </div>
    <p className="text-xs text-muted-foreground leading-relaxed">ONにすると、この論文の参考文献の概要・出典・PDF入手先を自動取得します（AIの利用枠を使用）。</p>
    {state.active.length > 0 && <p className="flex items-center gap-2 text-xs text-primary" role="status"><Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span className="truncate">{state.active.some(item => item.stopping) ? "収集を中止しています…" : `${state.active.length}件を同時に収集中`}</span></p>}
    {state.enabled && state.active.length === 0 && !state.error && <p className="text-xs text-muted-foreground" role="status">
      {!state.available ? state.capabilityError ? "AI接続を確認できません。接続が戻ると収集します。" : "Web検索に対応したAI接続を設定すると収集できます。"
        : state.loadError ? "保存済みの調査結果を読み込めないため、収集を待機しています。"
        : !state.connected ? "接続を待っています。" : !state.total ? "収集する参考文献がありません。" : state.completed === state.total ? "この論文の参考文献は取得済みです。"
        : state.busy ? "実行中の処理が終わると収集します。" : "未取得の文献を最大5件ずつ同時に調べます。"}
    </p>}
    {state.error && <div className="text-xs text-destructive space-y-2" role="alert">
      <p>収集を一時停止しました：{state.error}</p>
      <Button size="sm" variant="outline" onClick={() => setAutoResearch(true)}>収集を再開</Button>
    </div>}
  </div>;
}
