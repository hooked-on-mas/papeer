import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePersisted, migratePersisted, PERSIST_VERSION } from "../src/store/persisted.ts";

/** The store's saved defaults, as far as these settings go. */
const defaults = { zoom: 1, pageFilter: "normal" as const, inkBarOpen: false, sidePanel: null, sidePanelWidth: 420, activeTab: "reader" };

/** What a launch reads back: the saved data brought up to date, then merged over the defaults. */
const restore = (saved: object, version: number) => mergePersisted(migratePersisted(structuredClone(saved), version), { ...defaults });

test("data saved by v2 keeps its zoom, page filter, writing toolbar and side panel width, and leaves the side panel closed", () => {
  const state = restore({ zoom: 0, pageFilter: "sepia", inkBarOpen: true, focusPanel: "chat", focusPanelWidth: 512, activeTab: "notes" }, 2);
  // From v2 on, 0 is 「ページ全体」.
  assert.equal(state.zoom, 0);
  assert.equal(state.pageFilter, "sepia");
  assert.equal(state.inkBarOpen, true);
  assert.equal(state.sidePanelWidth, 512);
  assert.equal(state.sidePanel, null);
  assert.equal(state.activeTab, "notes");
  assert.ok(!("focusPanel" in state) && !("focusPanelWidth" in state));
});

test("data saved by v1 turns its 0 (fit width) into 1 and is brought up to v3 too", () => {
  const state = restore({ zoom: 0, pageFilter: "invert", inkBarOpen: true, focusPanel: "notes", focusPanelWidth: 380 }, 1);
  assert.equal(state.zoom, 1);
  assert.equal(restore({ zoom: 2 }, 1).zoom, 2);
  assert.equal(restore({ zoom: 0.5 }, 1).zoom, 1);
  assert.equal(state.pageFilter, "invert");
  assert.equal(state.inkBarOpen, true);
  assert.equal(state.sidePanelWidth, 380);
  assert.equal(state.sidePanel, null);
  assert.ok(!("focusPanel" in state) && !("focusPanelWidth" in state));
});

test("v2 data without a side panel width keeps the default one", () => {
  assert.equal(restore({ zoom: 1.5 }, 2).sidePanelWidth, 420);
  assert.equal(restore({ zoom: 1.5 }, 2).zoom, 1.5);
});

test("the current version's side panel is taken as saved, and one this version doesn't know is closed", () => {
  assert.equal(restore({ sidePanel: "summary", sidePanelWidth: 600 }, PERSIST_VERSION).sidePanel, "summary");
  assert.equal(restore({ sidePanel: "summary", sidePanelWidth: 600 }, PERSIST_VERSION).sidePanelWidth, 600);
  for (const sidePanel of ["sticky-notes", "reader", 3, "", undefined]) {
    assert.equal(restore({ sidePanel }, PERSIST_VERSION).sidePanel, null, String(sidePanel));
  }
  assert.equal(restore({ pageFilter: "neon" }, PERSIST_VERSION).pageFilter, "normal");
});

test("nothing saved gives the defaults", () => {
  assert.deepEqual(mergePersisted(migratePersisted(undefined, 0), { ...defaults }), defaults);
});
