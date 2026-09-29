import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { QK } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { askConfirm, showMessage } from "@/components/AppDialogs";
import { showError } from "@/components/errorDialog";
import type { LibraryDifference } from "./conflictSummary";
import {
  describeEntry, describeHistoryDifference, formatSize, groupEntries, validSetting,
  type HistoryEntry, type HistoryOverview, type LegacyItem, type OtherHistory,
} from "./historyApi";

const formatDate = (iso: string) => new Date(iso).toLocaleString();

/**
 * 設定 → バックアップ: this PC's history of the library (papeer/core/local_history.py). The states kept,
 * going back to one (`onRestore`, which confirms and runs the restore), what it takes and how much is kept,
 * and what earlier versions or an earlier place of the library left on this PC, removed after confirming.
 */
export function HistorySection({ disabled, onRestore }: { disabled: boolean; onRestore: (entryId: string, title: string) => void }) {
  const overview = useQuery({ queryKey: [QK.history],
    queryFn: async () => await unwrap(api.GET("/api/history")) as HistoryOverview });
  const [shown, setShown] = useState<string | null>(null);
  return <div className="border-t pt-4 space-y-4">
    <h3 className="font-medium">このPCの履歴から戻す</h3>
    <p>フォルダー同期で保存・取り込みしたときの状態と、選ばなかった側・戻す前の状態を、このPCに残しています（同期はされません）。同じ内容は1回だけ保存するため、容量はライブラリ1つ分と変更分です。</p>
    {overview.error ? <p role="alert" className="text-destructive">履歴を読み込めませんでした。</p>
      : !overview.data ? <p className="text-muted-foreground">読み込み中…</p>
      : <>
        <p className="text-muted-foreground text-xs">使用量：{formatSize(overview.data.usage.bytes)}（{overview.data.usage.entries}件の記録）</p>
        {overview.data.usage.unreadable > 0 && <p role="alert" className="text-amber-700 dark:text-amber-400">
          読み取れない記録が{overview.data.usage.unreadable}件あります（破損しているか、新しいバージョンのPapeerで作られています）。その間は、使われなくなったデータを片付けません。</p>}
        {!overview.data.entries.length ? <p className="text-muted-foreground">記録はまだありません。フォルダー同期をすると記録されます。</p>
          : groupEntries(overview.data.entries).map(part => <section key={part.group} aria-label={part.label} className="space-y-2">
            <h4 className="text-sm font-medium">{part.label}</h4>
            <ul className="space-y-2">{part.entries.map(entry =>
              <EntryRow key={entry.id} entry={entry} disabled={disabled} shown={shown === entry.id}
                onToggle={() => setShown(shown === entry.id ? null : entry.id)} onRestore={onRestore} />)}</ul>
          </section>)}
        {/* Keyed by the saved values: the fields start from them again once saved. */}
        <KeepSettings key={`${overview.data.settings.recent}-${overview.data.settings.days}`} overview={overview.data} disabled={disabled} />
      </>}
    <LegacyData disabled={disabled} />
    <OtherHistories disabled={disabled} />
  </div>;
}

function EntryRow({ entry, disabled, shown, onToggle, onRestore }: {
  entry: HistoryEntry; disabled: boolean; shown: boolean; onToggle: () => void; onRestore: (entryId: string, title: string) => void;
}) {
  const { title, detail } = describeEntry(entry, formatDate);
  const difference = useQuery({ queryKey: [QK.history, "difference", entry.id], enabled: shown && entry.complete, staleTime: 0,
    queryFn: async () => await unwrap(api.GET("/api/history/{entry_id}/difference", { params: { path: { entry_id: entry.id } } })) as LibraryDifference });
  const listId = useId();
  return <li className="space-y-1 rounded border p-2">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0"><p className="break-all">{title}</p><p className="text-muted-foreground text-xs break-all">{detail}</p></div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" disabled={!entry.complete} aria-expanded={shown} aria-controls={listId}
          aria-label={`${title} と今のライブラリとの違い`} onClick={onToggle}>違いを見る</Button>
        <Button variant="outline" size="sm" disabled={disabled || !entry.complete} aria-label={`${title} に戻す`}
          onClick={() => onRestore(entry.id, title)}>この時点に戻す</Button>
      </div>
    </div>
    {/* Always there (hidden while closed), so the button's aria-controls names an element. */}
    <div id={listId} hidden={!shown}>
      {!shown ? null
        : difference.error ? <p role="alert" className="text-destructive text-xs">違いを読み取れませんでした。</p>
        : !difference.data ? <p className="text-muted-foreground text-xs">読み込み中…</p>
        : <ul aria-label="今のライブラリとの違い" className="list-disc space-y-0.5 pl-5 text-xs break-all">
          {describeHistoryDifference(difference.data).map(line => <li key={line}>{line}</li>)}</ul>}
    </div>
  </li>;
}

/** How many states to keep (this PC's settings); lowering them asks first, naming how many go at the next sync. */
function KeepSettings({ overview, disabled }: { overview: HistoryOverview; disabled: boolean }) {
  const queryClient = useQueryClient();
  const [recent, setRecent] = useState(String(overview.settings.recent));
  const [days, setDays] = useState(String(overview.settings.days));
  const [saving, setSaving] = useState(false);
  const recentId = useId(), daysId = useId();
  const values = { recent: Number(recent), days: Number(days) };
  const valid = validSetting(values.recent, overview.ranges.recent) && validSetting(values.days, overview.ranges.days);
  const changed = values.recent !== overview.settings.recent || values.days !== overview.settings.days;
  const save = async () => {
    setSaving(true);
    try {
      const { removed } = await unwrap(api.GET("/api/history/preview", { params: { query: values } })) as { removed: HistoryEntry[] };
      if (removed.length && !await askConfirm("履歴の設定を変更",
        `この設定では、次の同期で${removed.length}件の記録（${formatSize(removed.reduce((sum, item) => sum + item.size, 0))}分の状態）が削除されます。\n`
        + removed.slice(0, 5).map(item => `・${describeEntry(item, formatDate).title}`).join("\n") + (removed.length > 5 ? "\n・ほか" : ""),
        "変更する", true)) return;
      await unwrap(api.PUT("/api/history/settings", { body: values }));
      await queryClient.invalidateQueries({ queryKey: [QK.history] });
    } catch (error) { showError(error, "履歴の設定を保存できませんでした"); }
    finally { setSaving(false); }
  };
  return <div className="space-y-2 rounded border p-3">
    <p className="text-sm font-medium">残す記録（このPCの設定）</p>
    <p className="text-muted-foreground text-xs">直近の記録に加えて、Papeerで同期した日ごとに、その日の最後の記録を残します（使わなかった日は数えません）。選ばなかった側と戻す前の記録は、それぞれ最新{overview.special_limit}件を残します。</p>
    <div className="flex flex-wrap items-end gap-4">
      <div className="space-y-1"><label htmlFor={recentId} className="text-sm">直近の記録（{overview.ranges.recent[0]}〜{overview.ranges.recent[1]}件）</label>
        <Input id={recentId} type="number" inputMode="numeric" min={overview.ranges.recent[0]} max={overview.ranges.recent[1]} className="w-24"
          value={recent} aria-invalid={!validSetting(values.recent, overview.ranges.recent)} onChange={e => setRecent(e.target.value)} /></div>
      <div className="space-y-1"><label htmlFor={daysId} className="text-sm">日ごとに残す日数（{overview.ranges.days[0]}〜{overview.ranges.days[1]}日）</label>
        <Input id={daysId} type="number" inputMode="numeric" min={overview.ranges.days[0]} max={overview.ranges.days[1]} className="w-24"
          value={days} aria-invalid={!validSetting(values.days, overview.ranges.days)} onChange={e => setDays(e.target.value)} /></div>
      <Button variant="outline" size="sm" disabled={disabled || saving || !valid || !changed} onClick={() => void save()}>保存</Button>
    </div>
    {!valid && <p role="alert" className="text-destructive text-xs">範囲内の整数を入力してください。</p>}
  </div>;
}

/** A list of things on this PC, each with its size, removed after the user picks them and confirms. */
function RemovableList<T>({ title, intro, items, keyOf, describe, confirmText, remove, disabled }: {
  title: string; intro: string; items: T[]; keyOf: (item: T) => string;
  describe: (item: T) => { label: string; detail: string; size: number }; confirmText: string;
  remove: (keys: string[]) => Promise<{ removed: string[]; failed: string[] }>; disabled: boolean;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const chosen = items.filter(item => picked.has(keyOf(item)));
  const total = (list: T[]) => list.reduce((sum, item) => sum + describe(item).size, 0);
  const toggle = (key: string, on: boolean) => setPicked(current => {
    const next = new Set(current);
    if (on) next.add(key); else next.delete(key);
    return next;
  });
  const run = async () => {
    if (!await askConfirm(title + "を削除", `${chosen.length}件（${formatSize(total(chosen))}）を削除します。${confirmText}\n`
      + chosen.map(item => `・${describe(item).label}`).join("\n"), "削除", true)) return;
    setRemoving(true);
    try {
      const result = await remove(chosen.map(keyOf));
      setPicked(new Set());
      if (result.failed.length) await showMessage("一部を削除できませんでした",
        `${result.failed.length}件は使用中などの理由で削除できませんでした。しばらくしてからもう一度お試しください。`);
    } catch (error) { showError(error, "削除できませんでした"); }
    finally { setRemoving(false); }
  };
  if (!items.length) return null;
  return <section aria-label={title} className="space-y-2 rounded border p-3">
    <h4 className="text-sm font-medium">{title}（{items.length}件・{formatSize(total(items))}）</h4>
    <p className="text-muted-foreground text-xs">{intro}</p>
    <ul className="space-y-1">{items.map(item => {
      const { label, detail } = describe(item);
      return <li key={keyOf(item)}><label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={picked.has(keyOf(item))} disabled={disabled || removing}
          onChange={e => toggle(keyOf(item), e.target.checked)} />
        <span className="min-w-0"><span className="block break-all">{label}</span>
          <span className="text-muted-foreground block text-xs break-all">{detail}</span></span>
      </label></li>;
    })}</ul>
    <Button variant="outline" size="sm" disabled={disabled || removing || !chosen.length} onClick={() => void run()}>
      {removing ? "削除しています…" : "選んだものを削除…"}</Button>
  </section>;
}

function LegacyData({ disabled }: { disabled: boolean }) {
  const queryClient = useQueryClient();
  const legacy = useQuery({ queryKey: [QK.history, "legacy"],
    queryFn: async () => await unwrap(api.GET("/api/history/legacy")) as { items: LegacyItem[]; size: number } });
  if (legacy.error) return <p role="alert" className="text-destructive">以前のデータの一覧を読み込めませんでした。</p>;
  return <RemovableList title="以前のデータ" items={legacy.data?.items ?? []} keyOf={item => item.path} disabled={disabled}
    intro="以前のバージョンがライブラリの隣に残したデータです（同期で選ばなかった側のZIPと、復元・取り込みの前のライブラリのフォルダー）。今は同じものをこのPCの履歴に残します。"
    confirmText="削除すると元に戻せません。"
    describe={item => ({ label: `${item.kind === "side_backup" ? "選ばなかった側のZIP" : "復元・取り込み前のライブラリ"}：${item.name}`,
      detail: [formatSize(item.size), item.modified && formatDate(item.modified), item.path].filter(Boolean).join("　"), size: item.size })}
    remove={async paths => {
      const result = await unwrap(api.POST("/api/history/legacy/remove", { body: { paths } })) as { removed: string[]; failed: string[] };
      await queryClient.invalidateQueries({ queryKey: [QK.history] });
      await queryClient.invalidateQueries({ queryKey: [QK.sideBackups] });
      await queryClient.invalidateQueries({ queryKey: [QK.drive] });
      return result;
    }} />;
}

function OtherHistories({ disabled }: { disabled: boolean }) {
  const queryClient = useQueryClient();
  const others = useQuery({ queryKey: [QK.history, "others"],
    queryFn: async () => await unwrap(api.GET("/api/history/others")) as { items: OtherHistory[]; size: number } });
  if (others.error) return <p role="alert" className="text-destructive">別の場所の履歴を読み込めませんでした。</p>;
  return <RemovableList title="別の場所のライブラリの履歴" items={others.data?.items ?? []} keyOf={item => item.key} disabled={disabled}
    intro="データ保存フォルダーの場所を変える前など、今のライブラリ以外のために残っている履歴です。"
    confirmText="その場所のライブラリを再び使う場合、その履歴から戻せなくなります。"
    describe={item => ({ label: item.library ? `${item.library}${item.library_exists ? "（ライブラリがあります）" : "（ライブラリは見つかりません）"}` : "場所の記録がない履歴",
      detail: [`${item.entries}件の記録`, formatSize(item.size), item.modified && formatDate(item.modified)].filter(Boolean).join("　"), size: item.size })}
    remove={async keys => {
      const result = await unwrap(api.POST("/api/history/others/remove", { body: { keys } })) as { removed: string[]; failed: string[] };
      await queryClient.invalidateQueries({ queryKey: [QK.history] });
      return result;
    }} />;
}
