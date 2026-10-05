import type { components } from "@/api/schema";

export type LayoutTiming = { origin: string; totalMs: number; count: number };
const duration = (ms: number) => ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} 秒`;
const states = { running: "取得中", completed: "完了", partial: "一部取得", canceled: "中止", failed: "失敗" };

export function MapTimings({ timing, layout }: { timing?: components["schemas"]["MapTiming"] | null; layout: LayoutTiming | null }) {
  if (!timing && !layout) return null;
  return <details className="text-xs text-muted-foreground" aria-label="論文マップの構築時間">
    <summary className="cursor-pointer">構築時間の内訳{timing && ` · ${duration(timing.total_ms)}（${states[timing.status]}）`}</summary>
    <div className="mt-2 space-y-2 max-h-64 overflow-auto">
      {timing ? <>
        <p>外部取得と候補の構築：{duration(timing.total_ms)} · 計測開始 {new Date(timing.started_at).toLocaleString()}</p>
        <table className="w-full text-left"><thead><tr><th className="font-medium py-1">工程</th><th className="font-medium py-1 whitespace-nowrap">時間</th><th className="font-medium py-1 whitespace-nowrap">回数</th></tr></thead>
          <tbody>{timing.steps.map(step => <tr key={step.key} className="border-t">
            <td className="py-1 pr-2 break-words" style={{ paddingLeft: `${Math.min(4, step.key.split("/").length - 2) * .75}rem` }}>{step.label}{step.errors > 0 && `（失敗 ${step.errors}回）`}{step.canceled > 0 && "（中止）"}</td>
            <td className="py-1 pr-2 whitespace-nowrap">{duration(step.total_ms)}</td><td className="py-1 whitespace-nowrap">{step.count}</td>
          </tr>)}<tr className="border-t"><td className="py-1">その他の処理</td><td className="py-1 whitespace-nowrap">{duration(timing.other_ms)}</td><td /></tr></tbody>
        </table>
        <p>工程の時間は、その下の工程を含みます。各行を合計しても全体時間にはなりません。通信、取得間隔の待機、同時処理の順番待ちは分けて表示しています。</p>
      </> : <p>外部取得の計測結果は、次の取得から表示します。</p>}
      <p data-layout-ms={layout?.totalMs} data-layout-count={layout?.count}>{layout ? `図の追加・再配置（この画面）：${duration(layout.totalMs)} · ${layout.count}回` : "図は保存済みの配置を使用しています。"} · 図の配置は上の取得時間には含みません。</p>
    </div>
  </details>;
}
