import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePersisted, migratePersisted, PERSIST_VERSION } from "../src/store/persisted.ts";

/** The store's saved defaults, as far as these settings go. */
const defaults = {
  zoom: 1, pageFilter: "normal" as const, inkBarOpen: false, inkBarStart: "closed" as const, sidePanel: null, sidePanelWidth: 420,
  activeTab: "reader",
};

/** What a launch reads back: the saved data brought up to date, then merged over the defaults. */
const restore = (saved: object, version: number) => mergePersisted(migratePersisted(structuredClone(saved), version), { ...defaults });

test("data saved by v2 keeps its zoom, page filter and side panel width, and leaves the side panel closed", () => {
  const state = restore({ zoom: 0, pageFilter: "sepia", inkBarOpen: true, focusPanel: "chat", focusPanelWidth: 512, activeTab: "notes" }, 2);
  // From v2 on, 0 is 「ページ全体」.
  assert.equal(state.zoom, 0);
  assert.equal(state.pageFilter, "sepia");
  // Saved before the writing toolbar had a start setting: it now starts closed, the default.
  assert.equal(state.inkBarOpen, false);
  assert.equal(state.inkBarStart, "closed");
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
  assert.equal(state.inkBarOpen, false);
  assert.equal(state.sidePanelWidth, 380);
  assert.equal(state.sidePanel, null);
  assert.ok(!("focusPanel" in state) && !("focusPanelWidth" in state));
});

test("v2 data without a side panel width keeps the default one", () => {
  assert.equal(restore({ zoom: 1.5 }, 2).sidePanelWidth, 420);
  assert.equal(restore({ zoom: 1.5 }, 2).zoom, 1.5);
});

test("the side panel always starts closed, even if it was saved open, and keeps its width", () => {
  assert.equal(restore({ sidePanel: "summary", sidePanelWidth: 600 }, PERSIST_VERSION).sidePanel, null);
  assert.equal(restore({ sidePanel: "summary", sidePanelWidth: 600 }, PERSIST_VERSION).sidePanelWidth, 600);
  for (const sidePanel of ["summary", "chat", "notes", "sticky-notes", "reader", 3, "", undefined]) {
    assert.equal(restore({ sidePanel }, PERSIST_VERSION).sidePanel, null, String(sidePanel));
  }
  assert.equal(restore({ pageFilter: "neon" }, PERSIST_VERSION).pageFilter, "normal");
});

test("nothing saved gives the defaults", () => {
  assert.deepEqual(mergePersisted(migratePersisted(undefined, 0), { ...defaults }), defaults);
});

test("the writing toolbar starts as its start setting says, and only 前回の状態を引き継ぐ takes how it was saved", () => {
  for (const inkBarOpen of [true, false]) {
    assert.equal(restore({ inkBarStart: "closed", inkBarOpen }, PERSIST_VERSION).inkBarOpen, false);
    assert.equal(restore({ inkBarStart: "open", inkBarOpen }, PERSIST_VERSION).inkBarOpen, true);
    assert.equal(restore({ inkBarStart: "last", inkBarOpen }, PERSIST_VERSION).inkBarOpen, inkBarOpen);
    // No choice saved yet (or data from before it existed): closed.
    assert.equal(restore({ inkBarOpen }, PERSIST_VERSION).inkBarOpen, false);
  }
  assert.equal(restore({ inkBarStart: "open" }, PERSIST_VERSION).inkBarStart, "open");
  assert.equal(restore({ inkBarStart: "last" }, PERSIST_VERSION).inkBarOpen, false);
  // A choice this version doesn't know (a newer one, or edited by hand) reads as closed.
  for (const inkBarStart of ["remember", "", 1, null]) {
    const state = restore({ inkBarStart, inkBarOpen: true }, PERSIST_VERSION);
    assert.equal(state.inkBarStart, "closed", String(inkBarStart));
    assert.equal(state.inkBarOpen, false, String(inkBarStart));
  }
});

test("the notebook's zoom and sidebar choice are kept apart from the PDF's zoom, and unreadable ones give the defaults", () => {
  const withNotebook = { ...defaults, notebookZoom: 0, notebookSidebarHidden: false };
  const restoreNotebook = (saved: object) => mergePersisted(migratePersisted(structuredClone(saved), PERSIST_VERSION), { ...withNotebook });
  // Saved before the notebook had its own: the defaults (「ページ全体」, shown).
  const before = restoreNotebook({ zoom: 2 });
  assert.equal(before.zoom, 2);
  assert.equal(before.notebookZoom, 0);
  assert.equal(before.notebookSidebarHidden, false);
  const saved = restoreNotebook({ zoom: 1, notebookZoom: 1.5, notebookSidebarHidden: true });
  assert.deepEqual([saved.zoom, saved.notebookZoom, saved.notebookSidebarHidden], [1, 1.5, true]);
  assert.equal(restoreNotebook({ notebookZoom: 0 }).notebookZoom, 0);
  assert.equal(restoreNotebook({ notebookZoom: 99 }).notebookZoom, 4);
  for (const notebookZoom of ["wide", null, NaN]) assert.equal(restoreNotebook({ notebookZoom }).notebookZoom, typeof notebookZoom === "number" ? 1 : 0, String(notebookZoom));
  for (const notebookSidebarHidden of ["yes", 1, null]) assert.equal(restoreNotebook({ notebookSidebarHidden }).notebookSidebarHidden, false, String(notebookSidebarHidden));
});
