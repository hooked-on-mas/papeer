/**
 * What the settings say of the sync folder's format (folder_sync.format_status): the choices saved in the
 * first format, and the confirmation before removing its old data. Kept free of React and the API client so
 * that tests/syncFolderText.test.ts can check them.
 */
import type { DriveFormat, Revision } from "./driveApi.ts";
import { formatSize } from "./historyApi.ts";

/**
 * What a choice's row adds after its PC and time: saved by an earlier Papeer (update that PC), or in the
 * first format by this version while the folder was being moved (not an earlier version); nothing otherwise.
 */
export function revisionNote(item: Pick<Revision, "legacy" | "old_papeer">): string {
  if (!item.legacy) return "";
  return item.old_papeer ? "（古いバージョンのPapeerで保存）" : "（同期の形式を移す途中に保存）";
}

/** The confirmation before removing the first format's revisions. `drive`: the sync folder is Google Drive's. */
export function oldDataConfirmText(info: Pick<DriveFormat, "removable" | "later" | "unmigrated">, drive = true): string {
  const lines = [
    `古い形式の同期データ ${info.removable.count}個（${formatSize(info.removable.size)}）を削除します。新しい形式に移ったので、同期には使いません。`,
    drive
      ? "Google Drive のごみ箱に移り、30日たつか、ごみ箱を空にするまで容量は空きません。"
      : "同期ソフトによっては、ごみ箱などに残る間は容量が空きません。",
  ];
  if (info.later.length) {
    const names = [...new Set(info.later.map(item => item.device))].join("、");
    lines.push(`${names} で保存された、まだ使うかどうか選んでいない同期データは残します。`);
  }
  if (info.unmigrated.length) lines.push(`${info.unmigrated.join("、")} は、まだ新しい形式で同期していません。`);
  lines.push("古い版のPapeerのPCは、更新するまで同期できなくなります。ほかにもPCがあれば、先にPapeerを更新して同期してください。");
  return lines.join("\n");
}
