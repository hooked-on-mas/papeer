import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NAMED_KEY_LIMIT, namedKeys, parseTold, toldAfter, unknownSettingKeys, VERSION_NOTICE_OFF_LABEL, versionNoticeKeys, versionNoticeMessage,
} from "../src/features/settings/settingsVersionNotice.ts";

const fresh = { dismissed: false, told: [] };

test("nothing to tell without unknown keys", () => {
  for (const value of [undefined, null, [], "future", {}, [1, null, "", "  "]]) {
    assert.equal(versionNoticeKeys(value, fresh), null, JSON.stringify(value));
  }
});

test("unknown keys are told, cleaned and sorted", () => {
  assert.deepEqual(versionNoticeKeys(["zeta", "alpha", "zeta", 3, ""], fresh), ["alpha", "zeta"]);
  assert.deepEqual(unknownSettingKeys(["b", "a"]), ["a", "b"]);
});

test("「今後表示しない」 on this PC silences the notice whatever keys turn up", () => {
  assert.equal(versionNoticeKeys(["future"], { dismissed: true, told: [] }), null);
  assert.equal(versionNoticeKeys(["other", "more"], { dismissed: true, told: ["future"] }), null);
});

test("told again within a launch only when a key not told yet turns up", () => {
  const told = toldAfter([], ["b", "a"]);
  assert.deepEqual(told, ["a", "b"]);
  // The same keys, in any order: already told.
  assert.equal(versionNoticeKeys(["a", "b"], { dismissed: false, told }), null);
  assert.equal(versionNoticeKeys(["b", "a", "a"], { dismissed: false, told }), null);
  // Fewer keys (one was saved away, or the other PC dropped it): nothing new.
  assert.equal(versionNoticeKeys(["a"], { dismissed: false, told }), null);
  // A sync brought another key: told again, naming them all.
  assert.deepEqual(versionNoticeKeys(["a", "b", "c"], { dismissed: false, told }), ["a", "b", "c"]);
  assert.deepEqual(versionNoticeKeys(["c"], { dismissed: false, told }), ["c"]);
  // What was told adds up: a key that went away and came back is not new.
  const later = toldAfter(told, ["c"]);
  assert.deepEqual(later, ["a", "b", "c"]);
  assert.equal(versionNoticeKeys(["a", "c"], { dismissed: false, told: later }), null);
});

test("the keys told, as kept in the session's storage across a reload", () => {
  assert.deepEqual(parseTold(JSON.stringify(toldAfter([], ["b", "a"]))), ["a", "b"]);
  for (const saved of [null, "", "{broken", "\"a\"", "{}", "[1,null]"]) assert.deepEqual(parseTold(saved), [], String(saved));
  // After a reload the same keys are not told again.
  assert.equal(versionNoticeKeys(["a", "b"], { dismissed: false, told: parseTold("[\"a\",\"b\"]") }), null);
});

test("the message names the settings file and keys, and says the old PC is the one to update", () => {
  const message = versionNoticeMessage(["future_setting", "another"]);
  assert.match(message, /ライブラリの設定（settings\.json）/);
  assert.match(message, /（future_setting、another）/);
  assert.match(message, /新しい版のPapeerを使っている/);
  assert.match(message, /使われません/);
  // Saving here drops them, and the sync takes that to the newer PC too.
  assert.match(message, /保存すると項目が消え/);
  assert.match(message, /同期先の新しい版のPCでも/);
  assert.match(message, /このPCのPapeerを新しい版に更新/);
  assert.ok(message.includes(`「${VERSION_NOTICE_OFF_LABEL}」`));
  assert.match(message, /保存先・同期/);
});

test("many keys: the first few are named and the rest counted", () => {
  const keys = Array.from({ length: NAMED_KEY_LIMIT + 2 }, (_, i) => `k${i}`);
  assert.equal(namedKeys(keys), `${keys.slice(0, NAMED_KEY_LIMIT).join("、")} ほか2件`);
  assert.equal(namedKeys(["only"]), "only");
});
