import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useSettings } from "@/api/hooks";
import { askConfirm } from "@/components/AppDialogs";
import { isAppClosing } from "@/app/appClosing";
import { useSyncState } from "./driveSync";
import {
  parseTold, toldAfter, VERSION_NOTICE_KEEP_LABEL, VERSION_NOTICE_OFF_LABEL, VERSION_NOTICE_TITLE, versionNoticeKeys, versionNoticeMessage,
} from "./settingsVersionNotice";

/**
 * Whether this PC tells about settings a newer Papeer wrote (settingsVersionNotice.ts). Kept in this
 * browser's storage, which is this PC's alone: the library's settings are synced, and another PC's
 * 「今後表示しない」 must not silence this one.
 */
export const useVersionNoticePrefs = create<{ dismissed: boolean; setDismissed: (dismissed: boolean) => void }>()(
  persist(
    (set) => ({
      dismissed: false,
      setDismissed: (dismissed) => set({ dismissed }),
    }),
    {
      name: "papeer-settings-version-notice",
      version: 1,
      partialize: (state) => ({ dismissed: state.dismissed }),
      merge: (saved, current) => ({ ...current, dismissed: (saved as { dismissed?: unknown } | undefined)?.dismissed === true }),
    },
  ),
);

/** Only one notice waits in the line of questions at a time (lib/dialogQueue.ts). */
const NOTICE_QUESTION_KEY = "settings-version-notice";
/**
 * The keys told during this launch. In sessionStorage, which a reload keeps (taking in another PC's library
 * reloads the page) and a new launch starts empty; in memory only when the storage cannot be used.
 */
const TOLD_STORAGE_KEY = "papeer-settings-version-told";
let toldInMemory: string[] = [];

function readTold(): string[] {
  try {
    return parseTold(sessionStorage.getItem(TOLD_STORAGE_KEY));
  } catch {
    return toldInMemory;
  }
}

function saveTold(keys: string[]): void {
  toldInMemory = keys;
  try {
    sessionStorage.setItem(TOLD_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Kept in memory: told again after a reload at worst.
  }
}

/** The unknown keys of the settings last loaded. */
let latestKeys: unknown = undefined;
/** A notice waits in the line or is on screen: another would only be turned away by its key. */
let asking = false;

/**
 * Tells about the latest unknown keys unless there is nothing new to tell (versionNoticeKeys), a notice is
 * already up, the app is closing, or a sync holds the screen with its waiting dialog. The keys count as
 * told once the notice is answered, i.e. it was on screen; keys that arrived meanwhile are told next.
 */
function tellUnknownKeys(): void {
  const sync = useSyncState.getState();
  if (asking || isAppClosing() || (sync.busy && !sync.background)) return;
  // Read now rather than subscribed: turning the notice back on in the settings takes effect from the
  // next launch (or the next keys), instead of putting it up over the settings at once.
  const keys = versionNoticeKeys(latestKeys, { dismissed: useVersionNoticePrefs.getState().dismissed, told: readTold() });
  if (!keys) return;
  asking = true;
  void askConfirm(VERSION_NOTICE_TITLE, versionNoticeMessage(keys), VERSION_NOTICE_OFF_LABEL, false,
    { key: NOTICE_QUESTION_KEY, urgent: false, cancelLabel: VERSION_NOTICE_KEEP_LABEL })
    .then((off) => {
      asking = false;
      saveTold(toldAfter(readTold(), keys));
      if (off) useVersionNoticePrefs.getState().setDismissed(true);
      tellUnknownKeys();
    });
}

/**
 * Mounted once: tells the user, when the settings are loaded (at launch, or again after a sync or a save),
 * that settings.json holds keys this version does not know. The notice waits its turn among the other
 * questions (dialogQueue), and while a sync holds the screen with its waiting dialog.
 */
export function SettingsVersionNotice() {
  const { data } = useSettings();
  const unknownKeys = data?.unknown_keys;
  const syncHoldsScreen = useSyncState((s) => s.busy && !s.background);
  useEffect(() => {
    latestKeys = unknownKeys;
    tellUnknownKeys();
  }, [unknownKeys, syncHoldsScreen]);
  return null;
}

/** 設定「保存先・同期」: turns the notice off, or back on after 「今後表示しない」. */
export function VersionNoticeSetting() {
  const dismissed = useVersionNoticePrefs((s) => s.dismissed);
  const setDismissed = useVersionNoticePrefs((s) => s.setDismissed);
  return <div className="space-y-1">
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={!dismissed} aria-describedby="version-notice-hint"
        onChange={(e) => setDismissed(!e.target.checked)} />
      別のPCで新しい版のPapeerを使っているとき（このPCの版が知らない設定があるとき）に知らせる
    </label>
    <p id="version-notice-hint" className="text-xs text-muted-foreground">
      このPCだけの設定です。通知で「{VERSION_NOTICE_OFF_LABEL}」を選ぶとオフになります。オンに戻すと、次に起動したときから再び知らせます。
    </p>
  </div>;
}
