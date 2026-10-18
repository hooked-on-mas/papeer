/**
 * What an automatic sync would do now (GET /api/drive/check, papeer/core/folder_sync.py: check_connected).
 * While a sync waits for another PC's data (status "waiting"), the check says "none" until some of it
 * arrives, then "quiet" (or "pull" once all of it is there): the sync is not run again every minute for nothing.
 */
export type SyncCheck = {
  /** none: nothing changed. quiet: publish this PC's changes or record a conflict, without touching the library. pull: take in another PC's library (reloads the page). */
  action: "none" | "quiet" | "pull";
  /** Changes whenever this library does (its hash, or a digest of its files' sizes and times); null when unknown. */
  local_version: string | null;
};

/** The longest an unpublished change waits while the user keeps editing. */
export const MAX_DELAY_MS = 5 * 60_000;

/**
 * How a sync runs. screen: with the waiting screen, as it may take in another PC's library and reload
 * the page. background: without it, and it never takes in (driveSync.ts: syncDrive).
 */
export type SyncMode = "screen" | "background";

/**
 * When the automatic sync runs after a check.
 *
 * Every publication copies the whole library into the sync folder, so publishing after each check
 * while the user is writing a memo would copy it every minute. This PC's changes are published once
 * the library stayed the same from one check to the next, or, while edits go on, once the first
 * unpublished change is MAX_DELAY_MS old. Taking in another PC's library does not wait, and closing
 * the app publishes whatever is left.
 *
 * The first sync after launch runs with the waiting screen, as does taking in another PC's library:
 * a newer revision from another PC is then taken in before the user starts editing here. (Until the
 * sidecar has hashed the library once, the check cannot tell a take-in from a publication; a background
 * sync could only defer it, and edits made meanwhile would turn it into a conflict.)
 */
export class PublishSchedule {
  private lastVersion: string | null = null;
  private pendingSince: number | null = null;
  private first = true;

  /**
   * Called with each check: how to sync now, or null. `editing`: the settings or a dialog holding a
   * draft is open, which a sync with the waiting screen waits for (the reload would discard the draft).
   */
  next(check: SyncCheck, now: number, editing: boolean): SyncMode | null {
    if (check.action === "none") this.first = false; // nothing to take in: later changes may go in the background
    if (!this.due(check, now)) return null;
    const mode: SyncMode = check.action === "pull" || this.first ? "screen" : "background";
    return mode === "screen" && editing ? null : mode;
  }

  /** After a background sync: when it deferred taking in another PC's library, do that now unless editing. */
  afterBackground(status: string | undefined, editing: boolean): SyncMode | null {
    return status === "deferred" && !editing ? "screen" : null;
  }

  /** Called with each check; true when a sync should run now. */
  due(check: SyncCheck, now: number): boolean {
    const changing = this.lastVersion !== null && check.local_version !== this.lastVersion;
    this.lastVersion = check.local_version;
    if (check.action !== "quiet") {
      this.pendingSince = null;
      return check.action === "pull";
    }
    this.pendingSince ??= now;
    return !changing || now - this.pendingSince >= MAX_DELAY_MS;
  }

  /** A sync ran: the changes seen so far are published (or waiting on the user's answer). */
  synced(): void {
    this.pendingSince = null;
    this.first = false;
  }
}
