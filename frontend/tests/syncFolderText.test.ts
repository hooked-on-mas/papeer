import assert from "node:assert/strict";
import { test } from "node:test";
import { oldDataConfirmText, revisionNote } from "../src/features/settings/syncFolderText.ts";

const removable = { count: 23, size: 18.4 * 1024 ** 3, ids: ["a"] };

test("the confirmation before removing the old data says what goes, the trash, and that earlier Papeers stop", () => {
  const text = oldDataConfirmText({ removable, later: [], unmigrated: [] });
  assert.match(text, /古い形式の同期データ 23個（18\.4 GB）を削除します/);
  assert.match(text, /ごみ箱に移り、30日たつか、ごみ箱を空にするまで容量は空きません/);
  assert.match(text, /古い版のPapeerのPCは、更新するまで同期できなくなります/);
  assert.doesNotMatch(text, /残します|まだ新しい形式で同期していません/);
  assert.doesNotMatch(oldDataConfirmText({ removable, later: [], unmigrated: [] }, false), /Google Drive/);
});

test("the confirmation names what is kept and the PCs not moved yet", () => {
  const text = oldDataConfirmText({
    removable,
    later: [{ id: "x", device: "PC-B", created: "", old_papeer: true }, { id: "y", device: "PC-B", created: "", old_papeer: false }],
    unmigrated: ["PC-C", "PC-D"],
  });
  assert.match(text, /PC-B で保存された、まだ使うかどうか選んでいない同期データは残します/);
  assert.match(text, /PC-C、PC-D は、まだ新しい形式で同期していません/);
});

test("a choice saved in the first format says by whom, and only an earlier Papeer's is called old", () => {
  assert.equal(revisionNote({}), "");
  assert.equal(revisionNote({ legacy: false, old_papeer: false }), "");
  assert.equal(revisionNote({ legacy: true, old_papeer: true }), "（古いバージョンのPapeerで保存）");
  assert.doesNotMatch(revisionNote({ legacy: true, old_papeer: false }), /古いバージョン/);
});
