import assert from "node:assert/strict";
import { test } from "node:test";
import { createMetadataSaver } from "../src/features/notes/metadataSaver.ts";
import { metaValues } from "../src/features/notes/paperMetadata.ts";
import { paperData } from "./support/paperData.ts";

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const server = metaValues(paperData({ id: "p", title: "Deep", first_author: "Smith", publication_year: "2024" }));

/** A saver whose PATCHes are recorded and answered by `answer` (throw to refuse). */
function saverWith(answer: (body: Record<string, string>) => void = () => undefined) {
  const patches: Record<string, string>[] = [];
  const saved: string[][] = [];
  const saver = createMetadataSaver({
    delay: 60_000, // Only flushes save in these tests.
    patch: async (_id, body) => { patches.push(body); answer(body); },
    saved: (_id, fields) => { saved.push(fields); },
  });
  return { saver, patches, saved };
}

test("when several fields are refused together, each is sent again on its own and the others are saved", async () => {
  const { saver, patches, saved } = saverWith((body) => {
    if ("doi" in body) throw new HttpError("DOIは「10.」で始まる形式で入力してください。", 400);
  });
  saver.showDraft("p", server);
  saver.typeField("p", "author", "Adams");
  saver.typeField("p", "doi", "xyz");
  await saver.flushDraft("p");
  assert.deepEqual(patches, [{ author: "Adams", doi: "xyz" }, { author: "Adams" }, { doi: "xyz" }]);
  assert.deepEqual(saved, [["author"]]);
  const draft = saver.store.getState().p;
  assert.equal(draft.saved.author, "Adams");
  assert.match(draft.problems.doi ?? "", /10\./);
  assert.deepEqual(saver.held().map((held) => held.fields), [["doi"]]);
  assert.deepEqual(saver.failed(), []);
  // Not sent again while it holds the refused value.
  await saver.flushDraft("p");
  assert.equal(patches.length, 3);
  // Closing without it puts the saved value back.
  saver.discardHeld();
  assert.equal(saver.store.getState().p.values.doi, "");
  assert.deepEqual(saver.held(), []);
});

test("a paper deleted meanwhile loses its draft", async () => {
  const { saver } = saverWith(() => { throw new HttpError("論文が見つかりません。", 404); });
  saver.showDraft("p", server);
  saver.typeField("p", "title", "New");
  await saver.flushDraft("p");
  assert.equal(saver.store.getState().p, undefined);
  assert.deepEqual([saver.held(), saver.failed()], [[], []]);
});

test("switching to another paper saves what was typed at once, then forgets the saved draft", async () => {
  const { saver, patches } = saverWith();
  saver.showDraft("p", server);
  saver.typeField("p", "title", "Deep Learning");
  await saver.hideDraft("p");
  assert.deepEqual(patches, [{ title: "Deep Learning" }]);
  assert.equal(saver.store.getState().p, undefined);
});

test("a value that cannot be saved stays after switching, with why; a failed save is told apart", async () => {
  let offline = false;
  const { saver, patches } = saverWith(() => { if (offline) throw new HttpError("バックエンドに接続できませんでした。", 0); });
  saver.showDraft("p", server);
  saver.typeField("p", "year", "20");
  await saver.hideDraft("p");
  assert.deepEqual(patches, []);
  assert.equal(saver.store.getState().p.values.year, "20");
  assert.match(saver.store.getState().p.problems.year ?? "", /4桁/);
  assert.deepEqual(saver.held().map((held) => held.paperId), ["p"]);

  offline = true;
  saver.showDraft("q", server);
  saver.typeField("q", "author", "Adams");
  await saver.flushAll();
  assert.deepEqual(saver.failed().map((held) => [held.paperId, held.fields]), [["q", ["author"]]]);
  assert.match(saver.store.getState().q.failure, /接続/);
  offline = false;
  await saver.flushAll();
  assert.deepEqual(saver.failed(), []);
  assert.equal(saver.store.getState().q.saved.author, "Adams");
});

test("deleting a paper forgets its draft, even one holding only values never sent", async () => {
  const { saver, patches } = saverWith((body) => {
    if ("doi" in body) throw new HttpError("DOIの形式が違います。", 400);
  });
  saver.showDraft("p", server);
  saver.typeField("p", "year", "20"); // Refused before sending.
  saver.showDraft("q", server);
  saver.typeField("q", "doi", "xyz"); // Refused by the sidecar, then not sent again.
  await saver.flushAll();
  assert.deepEqual(saver.held().map((held) => held.paperId).sort(), ["p", "q"]);
  await saver.hideDraft("p");
  await saver.hideDraft("q");
  await saver.flushAll(); // A backup or a sync: neither meets a 404.
  assert.equal(saver.held().length, 2);
  const sent = patches.length;
  saver.forget("p");
  saver.forget("q");
  await saver.flushAll();
  assert.deepEqual([saver.held(), saver.store.getState()], [[], {}]);
  assert.equal(patches.length, sent);
  // A save waiting for its delay is dropped with the draft.
  saver.showDraft("r", server);
  saver.typeField("r", "title", "Waiting");
  saver.forget("r");
  await saver.flushAll();
  assert.equal(patches.length, sent);
});
