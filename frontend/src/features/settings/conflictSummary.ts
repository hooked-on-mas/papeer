export type Counts = Partial<Record<"papers" | "notes" | "stickies" | "ink", number>>;

/** What differs between this PC's library and a newest revision of the sync folder (papeer/core/drive_sync.py: library_difference). */
export type LibraryDifference = {
  /** Papers only this PC has, and only the revision has, with a few of their titles. */
  local_only: number; remote_only: number; local_titles: string[]; remote_titles: string[];
  /** Among the papers both have: memos, sticky notes and pages of ink that differ. */
  notes: number; stickies: number; ink: number;
  local_counts: Counts; remote_counts: Counts;
};

/** A library a choice between two left out, kept on this PC (drive_sync.side_backups). Unknown fields are null. */
export type SideBackup = {
  path: string; name: string; size: number;
  side: "local" | "remote" | null; device: string | null;
  /** When that library was saved (a revision's time for the sync folder's), and when it was set aside. */
  created: string | null; saved: string | null;
  counts: Counts | null;
};

function papers(label: string, count: number, titles: string[]): string {
  const listed = titles.map(title => `「${title}」`).join("、");
  return `${label}にだけある論文：${count}件（${listed}${count > titles.length ? " ほか" : ""}）`;
}

/** The lines shown under a revision to choose from: what taking it, or keeping this PC's instead, would change. */
export function describeDifference(diff: LibraryDifference | null | undefined): string[] {
  if (!diff) return ["違いを読み取れませんでした（同期データがまだ届いていない可能性があります）。選ぶ前に各PCのデータを確認してください。"];
  const lines = [`論文の数：このPC ${diff.local_counts.papers ?? "—"}件、同期フォルダー ${diff.remote_counts.papers ?? "—"}件`];
  if (diff.remote_only) lines.push(papers("同期フォルダー", diff.remote_only, diff.remote_titles));
  if (diff.local_only) lines.push(papers("このPC", diff.local_only, diff.local_titles));
  const changed = [diff.notes && `メモ ${diff.notes}件`, diff.stickies && `付箋 ${diff.stickies}件`, diff.ink && `書き込み ${diff.ink}ページ`]
    .filter(Boolean);
  if (changed.length) lines.push(`両方にある論文で内容が異なるもの：${changed.join("・")}`);
  if (!diff.remote_only && !diff.local_only && !changed.length)
    lines.push("論文・メモ・付箋・書き込みに違いはありません（翻訳・サマリー・設定など、ほかの内容が異なります）。");
  return lines;
}

function counts(value: Counts | null): string {
  if (!value) return "";
  return `論文 ${value.papers ?? "—"}件・メモ ${value.notes ?? "—"}件・付箋 ${value.stickies ?? "—"}件・書き込み ${value.ink ?? "—"}ページ`;
}

/** How a kept library is listed: whose it was, when it was saved, and what it holds. */
export function describeSideBackup(item: SideBackup, formatDate: (iso: string) => string): { title: string; detail: string } {
  const whose = item.side === "local" ? `このPC（${item.device || "名前不明"}）のデータ`
    : item.side === "remote" ? `${item.device || "別のPC"} で同期したデータ` : item.name;
  const when = item.created ? `（${formatDate(item.created)} 時点）` : "";
  const detail = [counts(item.counts), item.saved && `退避：${formatDate(item.saved)}`, `${Math.max(1, Math.round(item.size / 1024 ** 2))} MB`]
    .filter(Boolean).join("　");
  return { title: whose + when, detail };
}
