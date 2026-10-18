/**
 * The folder sync's requests (sidecar/routes/drive.py). Their answers are not described in the OpenAPI
 * schema yet, so they are typed here, from papeer/core/drive_sync.py and papeer/core/folder_sync.py.
 */
import { api, unwrap } from "@/api/client";
import type { SyncCheck } from "./autoSyncSchedule";
import type { Counts, LibraryDifference } from "./conflictSummary";

/**
 * diff: what differs from this PC's library; null when it could not be read (absent before it was recorded).
 * legacy: saved in the first format beside the new one; old_papeer: by an earlier Papeer (false: by this
 * version while the folder was being moved) (drive_sync_v2.sync).
 */
export type Revision = { id: string; device: string; created: string; diff?: LibraryDifference | null; legacy?: boolean; old_papeer?: boolean };
/** A sync that stopped to ask first (papeer/core/drive_sync.py: shrunk_kinds, mark_restored). */
export type SyncReview = {
  reason: "shrunk" | "remote_shrunk" | "restored"; message: string;
  before: Counts | null; after: Counts; before_label: string; after_label: string;
  heads: string[]; // The sync folder's newest revisions when it stopped, for backing out through a choice.
};
/** What the sync waits for (drive_sync_v2.waiting_status): another PC's data still arriving. */
export type SyncWaiting = {
  reason: "arrival" | "base" | "damaged"; device: string | null; missing: number; since: string | null;
  /** Waited for a day or more: the message says what to check. */
  overdue: boolean;
  /** The heads when it began waiting, for going on with this PC's library (choice "local"). */
  heads: string[]; message: string;
};
export type DriveStatus = {
  connected: boolean; folder: string; auto_sync: boolean; last_sync: string | null;
  error: string | null; conflicts: Revision[]; previous_path: string | null;
  review: SyncReview | null; restored: boolean; library_missing: boolean;
  /** Revisions the last choice left out but could not keep as backups (unreadable or damaged). */
  not_set_aside: Revision[];
  /** The format this PC last synced in (folder_sync.status). */
  format?: 1 | 2;
  /** A migration begun here goes on at the next sync. */
  migration_pending?: boolean;
  waiting?: SyncWaiting | null;
};

type Amount = { count: number; size: number };
/** The sync folder's format and what the first format left there (folder_sync.format_status). */
export type DriveFormat = {
  /** null: not connected, or the folder could not be looked at. */
  format: 1 | 2 | null;
  migration_pending: boolean;
  /** The first format's revisions but the markers. */
  revisions: Amount;
  /** Those that may be removed now (none until the folder is in the new format). */
  removable: Amount & { ids: string[] };
  /** Revisions saved in the first format no choice took yet: kept. */
  later: { id: string; device: string; created: string; old_papeer: boolean }[];
  /** PCs that saved in the first format lately and have not synced in the new one. */
  unmigrated: string[];
  /** Every PC synced in the new format: the removal may be suggested. */
  ready: boolean;
};

/** GET /api/drive. */
export async function fetchDriveStatus(): Promise<DriveStatus> {
  return await unwrap(api.GET("/api/drive")) as DriveStatus;
}

/** GET /api/drive/check: what an automatic sync would do now. */
export async function fetchSyncCheck(): Promise<SyncCheck> {
  return await unwrap(api.GET("/api/drive/check")) as SyncCheck;
}

/** GET /api/drive/format. */
export async function fetchDriveFormat(): Promise<DriveFormat> {
  return await unwrap(api.GET("/api/drive/format")) as DriveFormat;
}

/** POST /api/drive/legacy/remove: the first format's revisions confirmed (their IDs as "removable" listed them). */
export async function removeOldSyncData(ids: string[]): Promise<{ removed: number; size: number; failed: number }> {
  return await unwrap(api.POST("/api/drive/legacy/remove", { body: { ids } })) as { removed: number; size: number; failed: number };
}
