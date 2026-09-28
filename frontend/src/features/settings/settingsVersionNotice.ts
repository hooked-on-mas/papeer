/**
 * The notice that the library's settings.json holds keys this Papeer does not know (GET /api/settings
 * `unknown_keys`): a newer Papeer wrote them, on another PC sharing the library through the sync folder
 * or in a backup restored here. This version does not use them, and saving the settings here drops them,
 * which the sync then carries to the newer PC too.
 * Kept free of React and the stores so that tests/settingsVersionNotice.test.ts can check the rules.
 *
 * - Told once per launch: the keys told are kept for the session (sessionStorage), so the reload that
 *   follows taking in another PC's library does not tell them again. Told again within the launch only
 *   when a key not told yet turns up; keys going away are not worth a notice.
 * - 「今後表示しない」 turns it off on this PC for good, whatever keys turn up later: the choice is this
 *   PC's (browser storage), never synced, so another PC still decides for itself. The setting in
 *   保存先・同期 turns it back on.
 */

export const VERSION_NOTICE_TITLE = "新しい版のPapeerの設定があります";
export const VERSION_NOTICE_KEEP_LABEL = "閉じる";
export const VERSION_NOTICE_OFF_LABEL = "今後表示しない";
/** Keys named in the notice; the rest are counted. */
export const NAMED_KEY_LIMIT = 5;

/** The unknown keys as the API (or the session's storage) gave them, cleaned: strings only, no blanks or duplicates, sorted. */
export function unknownSettingKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = value.filter((key): key is string => typeof key === "string" && key.trim() !== "");
  return [...new Set(keys)].sort();
}

/**
 * The keys to tell the user about now, or null when there is nothing to tell: no unknown keys, the notice
 * turned off on this PC (`dismissed`), or no key among them that was not told already this launch (`told`).
 * All the keys found are named, the ones told before included.
 */
export function versionNoticeKeys(unknownKeys: unknown, { dismissed, told }: { dismissed: boolean; told: readonly string[] }): string[] | null {
  if (dismissed) return null;
  const keys = unknownSettingKeys(unknownKeys);
  return keys.some((key) => !told.includes(key)) ? keys : null;
}

/** The keys told this launch, once a notice naming `keys` has been answered. */
export function toldAfter(told: readonly string[], keys: readonly string[]): string[] {
  return unknownSettingKeys([...told, ...keys]);
}

/** The keys told this launch as saved in the session's storage; nothing for a missing or broken value. */
export function parseTold(saved: string | null): string[] {
  if (!saved) return [];
  try {
    return unknownSettingKeys(JSON.parse(saved));
  } catch {
    return [];
  }
}

/** The keys as the notice names them: 「a、b、c」, with the ones past NAMED_KEY_LIMIT counted. */
export function namedKeys(keys: readonly string[]): string {
  const named = keys.slice(0, NAMED_KEY_LIMIT).join("、");
  return keys.length > NAMED_KEY_LIMIT ? `${named} ほか${keys.length - NAMED_KEY_LIMIT}件` : named;
}

export function versionNoticeMessage(keys: readonly string[]): string {
  return [
    `ライブラリの設定（settings.json）に、このPCのPapeerが知らない項目があります（${namedKeys(keys)}）。`
      + "別のPCで新しい版のPapeerを使っている（または新しい版で作ったバックアップから復元した）可能性があります。",
    "この版ではこれらの設定は使われません。このPCで設定を保存すると項目が消え、同期先の新しい版のPCでもその設定が使われなくなることがあります。"
      + "必要なら、このPCのPapeerを新しい版に更新して版をそろえてください。",
    `「${VERSION_NOTICE_OFF_LABEL}」を選ぶと、このPCではこの通知を表示しません。設定 → 保存先・同期 で元に戻せます。`,
  ].join("\n\n");
}
