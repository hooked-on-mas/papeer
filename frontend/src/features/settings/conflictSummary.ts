/**
 * What a revision, a state of the history or a kept library holds (papeer/core/drive_sync.py: library_counts).
 * "papers" counts PDF papers only; "notebooks" the handwritten notebooks and "attachments" the memos and
 * documents items hold, so that losing memos is not told as papers lost. A record made by an earlier Papeer
 * lacks the last two, and a library of papers only has 0 of them: they are left out of what is said, not
 * shown as 0 (see HELD_COUNTS).
 */
export type Counts = Partial<Record<"papers" | "stickies" | "ink" | "notebooks" | "attachments", number>>;

/** The counts' labels in the table a sync review shows (drive_sync.COUNT_LABELS, with the unit of a page of ink). */
export const COUNT_LABELS: [keyof Counts, string][] = [
  ["papers", "論文"], ["stickies", "付箋"], ["ink", "書き込み（ページ）"],
  ["notebooks", "ノート"], ["attachments", "メモ・資料"],
];

/**
 * The counts that are told only where there is something to tell: the notebooks and the memos and documents,
 * which a library of papers only has none of. The first three are always told, 0 or not.
 */
const HELD_COUNTS: ReadonlySet<keyof Counts> = new Set(["notebooks", "attachments"]);

/** Whether a count is told: always for the three every library has, for the others when it is above 0. */
function told(key: keyof Counts, ...values: (number | undefined)[]): boolean {
  return !HELD_COUNTS.has(key) || values.some((value) => (value ?? 0) > 0);
}

/**
 * The rows of the table of what a review compares, before and after (a count unknown is undefined). A row
 * is left out when neither side knows it, which is how a record of an earlier Papeer lacks the newer counts,
 * and a row of notebooks or documents when neither side has any: one that went from some to none stays, as
 * a loss. `shrunk`: it went down, which the table marks.
 */
export function countRows(before: Counts | null, after: Counts | null): { key: keyof Counts; label: string; before?: number; after?: number; shrunk: boolean }[] {
  return COUNT_LABELS.flatMap(([key, label]) => {
    const [was, now] = [before?.[key], after?.[key]];
    return (was === undefined && now === undefined) || !told(key, was, now) ? [] : [{ key, label, before: was, after: now, shrunk: was !== undefined && now !== undefined && now < was }];
  });
}

/** What differs between this PC's library and a newest revision of the sync folder (papeer/core/drive_sync.py: library_difference). */
export type LibraryDifference = {
  /** Papers only this PC has, and only the revision has, with a few of their titles. */
  local_only: number; remote_only: number; local_titles: string[]; remote_titles: string[];
  /** Among the papers both have: memos, sticky notes and pages of ink that differ. */
  attachments: number; stickies: number; ink: number;
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

/** What the lines name the items that one side has and the other lacks: notebooks are listed with the papers. */
export function itemNoun(diff: LibraryDifference): string {
  return (diff.local_counts.notebooks ?? 0) > 0 || (diff.remote_counts.notebooks ?? 0) > 0 ? "論文・ノート" : "論文";
}

/**
 * The lines about the notebooks and the memos and documents, which the paper count does not tell: shown
 * when either side has some, so that a library of papers only says nothing of them.
 */
export function holdingLines(diff: LibraryDifference, names: { local: string; remote: string }): string[] {
  return ([["notebooks", "ノート"], ["attachments", "メモ・資料"]] as const).flatMap(([key, label]) => {
    const [local, remote] = [diff.local_counts[key], diff.remote_counts[key]];
    return (local ?? 0) > 0 || (remote ?? 0) > 0
      ? [`${label}の数：${names.local} ${local ?? "—"}件、${names.remote} ${remote ?? "—"}件`] : [];
  });
}

function papers(label: string, count: number, titles: string[], noun: string): string {
  const listed = titles.map(title => `「${title}」`).join("、");
  return `${label}にだけある${noun}：${count}件（${listed}${count > titles.length ? " ほか" : ""}）`;
}

/** The lines shown under a revision to choose from: what taking it, or keeping this PC's instead, would change. */
export function describeDifference(diff: LibraryDifference | null | undefined): string[] {
  if (!diff) return ["違いを読み取れませんでした（同期データがまだ届いていない可能性があります）。選ぶ前に各PCのデータを確認してください。"];
  const lines = [`論文の数：このPC ${diff.local_counts.papers ?? "—"}件、同期フォルダー ${diff.remote_counts.papers ?? "—"}件`];
  lines.push(...holdingLines(diff, { local: "このPC", remote: "同期フォルダー" }));
  if (diff.remote_only) lines.push(papers("同期フォルダー", diff.remote_only, diff.remote_titles, itemNoun(diff)));
  if (diff.local_only) lines.push(papers("このPC", diff.local_only, diff.local_titles, itemNoun(diff)));
  const changed = [diff.attachments && `メモ・資料 ${diff.attachments}件`, diff.stickies && `付箋 ${diff.stickies}件`, diff.ink && `書き込み ${diff.ink}ページ`]
    .filter(Boolean);
  if (changed.length) lines.push(`両方にある論文で内容が異なるもの：${changed.join("・")}`);
  if (!diff.remote_only && !diff.local_only && !changed.length)
    lines.push("論文・メモ・付箋・書き込みに違いはありません（翻訳・サマリー・設定など、ほかの内容が異なります）。");
  return lines;
}

/** What a record holds, in a line: the notebooks and documents only when the record has some. */
export function describeCounts(value: Counts | null): string {
  if (!value) return "";
  const held = [told("notebooks", value.notebooks) && `ノート ${value.notebooks}件`,
    told("attachments", value.attachments) && `メモ・資料 ${value.attachments}件`];
  return [`論文 ${value.papers ?? "—"}件`, `付箋 ${value.stickies ?? "—"}件`,
    `書き込み ${value.ink ?? "—"}ページ`, ...held].filter(Boolean).join("・");
}

/** How a kept library is listed: whose it was, when it was saved, and what it holds. */
export function describeSideBackup(item: SideBackup, formatDate: (iso: string) => string): { title: string; detail: string } {
  const whose = item.side === "local" ? `このPC（${item.device || "名前不明"}）のデータ`
    : item.side === "remote" ? `${item.device || "別のPC"} で同期したデータ` : item.name;
  const when = item.created ? `（${formatDate(item.created)} 時点）` : "";
  const detail = [describeCounts(item.counts), item.saved && `退避：${formatDate(item.saved)}`, `${Math.max(1, Math.round(item.size / 1024 ** 2))} MB`]
    .filter(Boolean).join("　");
  return { title: whose + when, detail };
}
