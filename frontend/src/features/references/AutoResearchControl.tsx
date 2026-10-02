import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openSettings } from "@/features/settings/settingsNavigation";
import { setAutoResearch, type useAutomaticResearch } from "./autoResearch";

export function AutoResearchControl({ state, selectFailed }: { state: ReturnType<typeof useAutomaticResearch>; selectFailed: (key: string) => void }) {
  return <div className="border-b px-4 py-2 space-y-1 bg-muted/20 shrink-0">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs font-medium">{state.enabled ? "参考文献を自動収集" : "AIによる情報取得はOFFです"}</span>
      {state.enabled && <span className="text-xs text-muted-foreground" role="status">取得済み {state.completed} / {state.total}</span>}
      {(!state.enabled || !state.available) && <Button size="sm" variant="link" className="h-auto p-0" onClick={() => openSettings("connection")}>情報取得の設定を開く</Button>}
    </div>
    {state.active.length > 0 && <p className="flex items-center gap-2 text-xs text-primary" role="status"><Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span className="truncate">{state.active.some(item => item.stopping) ? "収集を中止しています…" : `${state.active.length}件を同時に収集中`}</span></p>}
    {state.enabled && state.active.length === 0 && !state.error && (!state.available || state.loadError || !state.connected) && <p className="text-xs text-muted-foreground" role="status">
      {!state.available ? "情報取得の接続を確認できません。接続が戻ると収集します。"
        : state.loadError ? "保存済みの調査結果を読み込めないため、収集を待機しています。"
        : !state.connected ? "接続を待っています。" : !state.total ? "収集する参考文献がありません。" : state.completed === state.total ? "この論文の参考文献は取得済みです。"
        : state.busy ? "実行中の処理が終わると収集します。" : state.exhausted ? "確認できなかった文献は、詳細の確認用リンクから調べられます。" : "未取得の文献を最大5件ずつ同時に調べます。"}
    </p>}
    {state.enabled && state.error && <div className="text-xs text-destructive space-y-2" role="alert">
      <details><summary className="cursor-pointer">収集を一時停止しました · 詳細</summary><p className="mt-2 whitespace-pre-wrap break-words">{state.error}</p></details>
      <Button size="sm" variant="outline" onClick={() => setAutoResearch(true)}>収集を再開</Button>
    </div>}
    {state.failedReferences.length > 0 && <details className="text-xs text-amber-600">
      <summary className="cursor-pointer">文献の照合を確認してください · {state.failedReferences.length}件</summary>
      <p className="mt-1">該当文献は自動で再試行しません。ほかの文献は自動収集の対象です。</p>
      <div className="mt-1 max-h-32 overflow-auto space-y-1">{state.failedReferences.map(ref => <button key={ref.research_key}
        className="block text-left underline break-words" onClick={() => selectFailed(ref.research_key)}>{ref.title || ref.raw}</button>)}</div>
    </details>}
  </div>;
}
