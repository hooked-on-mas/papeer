import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fieldsToSend, localProblem, metaValues, newDraft, requestBody, unsavedFields, withRejected, withReverted, withSaved,
  withServerValues, withTyped, type MetaValues,
} from "../src/features/notes/paperMetadata.ts";

const server: MetaValues = metaValues({ id: "p", title: "Deep", first_author: "Smith", publication_year: "2024", collection_name: "制御 / 読書会" });

test("a field is unsaved while it differs by more than the spaces the sidecar trims", () => {
  let draft = newDraft(server);
  assert.deepEqual(unsavedFields(draft), []);
  draft = withTyped(draft, "title", "Deep ");
  draft = withTyped(draft, "collection", "制御/読書会");
  assert.deepEqual(unsavedFields(draft), []);
  draft = withTyped(draft, "title", "Deep L");
  assert.deepEqual(unsavedFields(draft), ["title"]);
});

test("a value that breaks a rule is kept back with why, the others are sent", () => {
  let draft = withTyped(withTyped(withTyped(newDraft(server), "year", "20"), "author", "Adams"), "title", " ");
  const { send, problems } = fieldsToSend(draft);
  assert.deepEqual(send, ["author"]);
  assert.match(problems.year ?? "", /半角数字4桁/);
  assert.match(problems.title ?? "", /タイトル/);
  assert.equal(localProblem("year", ""), null); // Unknown is allowed.
  assert.equal(localProblem("venue", "x".repeat(301))?.includes("300"), true);
  draft = withTyped(draft, "year", "2020");
  assert.deepEqual(fieldsToSend(draft).send, ["author", "year"]);
  assert.deepEqual(requestBody(["title", "year", "author"], { ...draft.values, title: " T ", year: " 2020 ", author: " A " }),
    { title: "T", year: "2020", author: " A " });
});

test("a value the sidecar refused is not sent again until it is changed, or put back", () => {
  let draft = withTyped(newDraft(server), "doi", "10.1000/a b");
  draft = withRejected(draft, "doi", "10.1000/a b", "DOIに空白…");
  assert.deepEqual(fieldsToSend(draft), { send: [], problems: { doi: "DOIに空白…" } });
  assert.deepEqual(unsavedFields(draft), ["doi"]);
  const typed = withTyped(draft, "doi", "10.1000/ab");
  assert.deepEqual(fieldsToSend(typed).send, ["doi"]);
  assert.equal(typed.problems.doi, undefined);
  // Changed, then back to the refused value: not sent, and why is said again.
  const back = withTyped(withTyped(draft, "doi", "10.1000/a bc"), "doi", "10.1000/a b");
  assert.deepEqual(fieldsToSend(back), { send: [], problems: { doi: "DOIに空白…" } });
  const reverted = withReverted(draft, "doi");
  assert.deepEqual(unsavedFields(reverted), []);
  assert.deepEqual([reverted.values.doi, reverted.problems, reverted.rejected], ["", {}, {}]);
});

test("once saved, the sidecar's value is shown, but not to take a typed space away", () => {
  let draft = withTyped(withTyped(newDraft(server), "title", "Deep "), "doi", "https://doi.org/10.1000/X");
  draft = withSaved(draft, ["title", "doi"], draft.values);
  assert.deepEqual(unsavedFields(draft), []);
  const loaded = withServerValues(draft, { ...server, title: "Deep", doi: "10.1000/X" });
  assert.equal(loaded.values.title, "Deep ");
  assert.equal(loaded.values.doi, "10.1000/X");
  assert.deepEqual(unsavedFields(loaded), []);
});

test("a change made elsewhere shows unless the field is being edited", () => {
  let draft = withTyped(newDraft(server), "title", "Mine");
  draft = withServerValues(draft, { ...server, title: "Theirs", author: "Adams" });
  assert.equal(draft.values.title, "Mine");
  assert.equal(draft.values.author, "Adams");
  assert.deepEqual(unsavedFields(draft), ["title"]);
  const same = newDraft(server);
  assert.equal(withServerValues(same, server), same);
});
