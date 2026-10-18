import assert from "node:assert/strict";
import { test } from "node:test";
import { libraryQueryKey, type ArtifactView } from "../src/runtime/contracts.ts";
import { webLibraryCapabilities } from "../src/runtime/capabilities.ts";
import { toLibraryItem } from "../src/runtime/libraryItems.ts";
import { paperData } from "./support/paperData.ts";

test("desktop and snapshot rows produce the same transport-free presentation model", () => {
  const row = paperData({ id: "paper", title: "論文", first_author: " Smith ", publication_year: "2024", collection_name: "調査" });
  assert.deepEqual(toLibraryItem(row), {
    id: "paper", title: "Smith (2024) 論文", kind: "pdf", parentId: null, collectionName: "調査",
  });
  assert.deepEqual(toLibraryItem(row), toLibraryItem(JSON.parse(JSON.stringify(row))));
  assert.equal(toLibraryItem({ id: "old", original_name: "scan.pdf" }).kind, "pdf");
  assert.equal(toLibraryItem({ id: "future", kind: "future-format" }).kind, "unknown");
  assert.equal(toLibraryItem({ id: "note", kind: "notebook", parent_id: "paper" }).parentId, "paper");
  assert.equal(toLibraryItem({ id: "bad", title: { secret: "not a title" } }).title, "無題");
});

test("Web can read saved translations and chats without granting AI execution or provider settings", () => {
  const translated: ArtifactView = { id: "opaque", itemId: "paper", label: "訳", filename: "translated.pdf", mediaType: "application/pdf",
    role: "translated", annotationTarget: { paperId: "paper", side: "translated", sourceSha256: "hash" } };
  for (const artifacts of [[], [translated]]) {
    for (const saved of [false, true]) {
      const caps = webLibraryCapabilities(artifacts, saved);
      assert.equal(caps["translation.generate"], false);
      assert.equal(caps["chat.generate"], false);
      assert.equal(caps["provider.configure"], false);
      assert.equal(caps["notes.read"], saved);
      assert.equal(caps["chat.read"], saved);
      assert.equal(caps["translation.read"], artifacts.length > 0);
      assert.equal(caps["ink.append"], artifacts.length > 0);
    }
  }
  assert.equal(webLibraryCapabilities([{ ...translated, annotationTarget: undefined }], true)["ink.append"], false);
});

test("read cache keys cannot collide across login epochs, libraries, or revisions", () => {
  const scope = { sessionKey: "epoch-1", libraryId: "library-1", revision: "revision-1" };
  const key = libraryQueryKey(scope, "reading", "paper");
  for (const part of ["sessionKey", "libraryId", "revision"] as const) {
    assert.notDeepEqual(libraryQueryKey({ ...scope, [part]: "changed" }, "reading", "paper"), key);
  }
  assert.notDeepEqual(libraryQueryKey(scope, "reading", "other-paper"), key);
});
