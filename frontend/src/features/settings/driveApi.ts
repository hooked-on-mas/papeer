/**
 * The folder sync's requests (sidecar/routes/drive.py). Their answers are not described in the OpenAPI
 * schema yet, so they are typed here, from papeer/core/drive_sync.py.
 */
import { api, unwrap } from "@/api/client";
import type { SyncCheck } from "./autoSyncSchedule";
import type { Counts, LibraryDifference } from "./conflictSummary";

/** diff: what differs from this PC's library; null when it could not be read (absent before it was recorded). */
export type Revision = { id: string; device: string; created: string; diff?: LibraryDifference | null };
/** A sync that stopped to ask first (papeer/core/drive_sync.py: shrunk_kinds, mark_restored). */
export type SyncReview = {
  reason: "shrunk" | "remote_shrunk" | "restored"; message: string;
  before: Counts | null; after: Counts; before_label: string; after_label: string;
  heads: string[]; // The sync folder's newest revisions when it stopped, for backing out through a choice.
};
export type DriveStatus = {
  connected: boolean; folder: string; auto_sync: boolean; last_sync: string | null;
  error: string | null; conflicts: Revision[]; previous_path: string | null;
  review: SyncReview | null; restored: boolean; library_missing: boolean;
  /** Revisions the last choice left out but could not keep as backups (unreadable or damaged). */
  not_set_aside: Revision[];
};

/** GET /api/drive. */
export async function fetchDriveStatus(): Promise<DriveStatus> {
  return await unwrap(api.GET("/api/drive")) as DriveStatus;
}

/** GET /api/drive/check: what an automatic sync would do now. */
export async function fetchSyncCheck(): Promise<SyncCheck> {
  return await unwrap(api.GET("/api/drive/check")) as SyncCheck;
}
