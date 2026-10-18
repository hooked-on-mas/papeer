import { describeCounts, holdingLines, itemNoun, type Counts, type LibraryDifference } from "./conflictSummary.ts";

/** One state in this PC's history of the library (papeer/core/local_history.py: entries). */
export type HistoryEntry = {
  id: string; created: string; day: string;
  kind: "publish" | "pull" | "set_aside" | "before_restore";
  /** Which part of the list it belongs to: the newest syncs, the last of a day, or set aside / before a restore. */
  group: "recent" | "daily" | "special";
  device: string; counts: Counts | null; size: number; files: number;
  /** Every blob is there (compressed ones by name; a restore reads them all). */
  complete: boolean;
  /** Recorded from a library on this PC (false: from another PC's revision, set aside). */
  verified: boolean;
  side?: "local" | "remote"; source_device?: string; source_created?: string;
};

export type HistorySettings = { recent: number; days: number };

export type HistoryOverview = {
  entries: HistoryEntry[];
  usage: { bytes: number; entries: number; blobs: number; unreadable: number };
  settings: HistorySettings;
  ranges: { recent: [number, number]; days: [number, number] };
  special_limit: number;
};

/** What earlier versions left beside the library (local_history.legacy_items). */
export type LegacyItem = { kind: "side_backup" | "before_restore"; path: string; name: string; size: number; modified: string | null };

/** The history of a library at another place (moved, or another data folder) (local_history.other_histories). */
export type OtherHistory = { key: string; library: string | null; library_exists: boolean; size: number; entries: number; modified: string | null };

export const GROUP_LABELS: Record<HistoryEntry["group"], string> = {
  recent: "最近の同期", daily: "日ごと（その日の最後）", special: "退避・戻す前",
};

const KIND_LABELS: Record<HistoryEntry["kind"], string> = {
  publish: "保存", pull: "取り込み", set_aside: "退避", before_restore: "戻す前",
};

/** Bytes as the settings show them: MB below a gigabyte, at least 1 MB when not empty. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** The entries of each group, in the order the list shows the groups; groups without entries are left out. */
export function groupEntries(entries: HistoryEntry[]): { group: HistoryEntry["group"]; label: string; entries: HistoryEntry[] }[] {
  return (["recent", "daily", "special"] as const)
    .map(group => ({ group, label: GROUP_LABELS[group], entries: entries.filter(entry => entry.group === group) }))
    .filter(part => part.entries.length);
}

/** How a state is listed: when, what kind and whose, and what it holds. */
export function describeEntry(entry: HistoryEntry, formatDate: (iso: string) => string): { title: string; detail: string } {
  const whose = entry.kind === "set_aside"
    ? (entry.side === "remote" ? `${entry.source_device || "別のPC"} のデータ（選ばなかった側）` : "このPCのデータ（選ばなかった側）")
    : entry.kind === "pull" ? `${entry.source_device || "別のPC"} から取り込み` : KIND_LABELS[entry.kind];
  const title = `${formatDate(entry.created)}　${KIND_LABELS[entry.kind]}${entry.kind === "publish" || entry.kind === "before_restore" ? "" : `：${whose}`}`;
  const detail = [describeCounts(entry.counts), formatSize(entry.size), !entry.complete && "一部のデータが見つからないため戻せません"]
    .filter(Boolean).join("　");
  return { title, detail };
}

/** Whether the value is a whole number within the range the settings allow. */
export function validSetting(value: number, [low, high]: [number, number]): boolean {
  return Number.isInteger(value) && value >= low && value <= high;
}

/** What differs between the library now and a state of the history (drive_sync.library_difference, the state as "remote"). */
export function describeHistoryDifference(diff: LibraryDifference): string[] {
  const titles = (items: string[], count: number) => `${items.map(title => `「${title}」`).join("、")}${count > items.length ? " ほか" : ""}`;
  const lines = [`論文の数：今 ${diff.local_counts.papers ?? "—"}件、この時点 ${diff.remote_counts.papers ?? "—"}件`];
  lines.push(...holdingLines(diff, { local: "今", remote: "この時点" }));
  if (diff.remote_only) lines.push(`この時点にだけある${itemNoun(diff)}（戻すと戻ります）：${diff.remote_only}件（${titles(diff.remote_titles, diff.remote_only)}）`);
  if (diff.local_only) lines.push(`今だけある${itemNoun(diff)}（戻すとなくなります）：${diff.local_only}件（${titles(diff.local_titles, diff.local_only)}）`);
  const changed = [diff.attachments && `メモ・資料 ${diff.attachments}件`, diff.stickies && `付箋 ${diff.stickies}件`, diff.ink && `書き込み ${diff.ink}ページ`]
    .filter(Boolean);
  if (changed.length) lines.push(`両方にある論文で内容が異なるもの：${changed.join("・")}`);
  if (!diff.remote_only && !diff.local_only && !changed.length)
    lines.push("論文・メモ・付箋・書き込みに違いはありません（翻訳・サマリー・設定など、ほかの内容が異なる場合があります）。");
  return lines;
}
