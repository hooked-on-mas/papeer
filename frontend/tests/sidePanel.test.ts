import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSidePanel, mergeSavedAnchors, openBesideReader, parseAnchors, savedAnchor, shownSidePanel, SIDE_PANELS, sidePanelOpen, summaryPlacement, tabChange, type SidePanel,
} from "../src/features/reader/sidePanel.ts";
import { onScreen } from "../src/features/reader/pageTurn.ts";

const TABS = ["reader", "summary", "chat", "notes", "sticky-notes"];

test("the side panel shows beside the reader only, in the normal view as in focus mode", () => {
  assert.equal(shownSidePanel({ activeTab: "reader", sidePanel: "chat", hasPaper: true }), "chat");
  assert.equal(shownSidePanel({ activeTab: "reader", sidePanel: null, hasPaper: true }), null);
  // Without a paper there is nothing to show beside.
  assert.equal(shownSidePanel({ activeTab: "reader", sidePanel: "notes", hasPaper: false }), null);
});

test("a pane is never shown in the side panel and its tab at once", () => {
  for (const activeTab of TABS) {
    for (const sidePanel of [null, ...SIDE_PANELS]) {
      const shown = shownSidePanel({ activeTab, sidePanel, hasPaper: true });
      // The reader is the only tab the panel shows beside, so the tab of the pane in it is never the one shown.
      if (shown) assert.notEqual(shown, activeTab);
      if (activeTab !== "reader") assert.equal(shown, null, `${activeTab} / ${sidePanel}`);
    }
  }
});

test("the side panel keeps its room while another tab is shown, so that the hidden reader keeps its size", () => {
  assert.ok(sidePanelOpen({ sidePanel: "chat", hasPaper: true }));
  assert.ok(!sidePanelOpen({ sidePanel: null, hasPaper: true }));
  assert.ok(!sidePanelOpen({ sidePanel: "chat", hasPaper: false }));
});

test("choosing a tab in the normal view shows it and keeps the side panel for the reader", () => {
  const state = { activeTab: "reader", focusMode: false, sidePanel: "chat" as SidePanel | null };
  assert.deepEqual(tabChange(state, "chat"), { activeTab: "chat" });
  assert.deepEqual(tabChange(state, "summary"), { activeTab: "summary" });
  // Coming back to the reader brings the panel back as it was.
  assert.deepEqual(tabChange({ ...state, activeTab: "chat" }, "reader"), { activeTab: "reader" });
});

test("choosing a tab in focus mode opens it beside the reader; 付箋 leaves focus mode", () => {
  const state = { activeTab: "reader", focusMode: true, sidePanel: null };
  assert.deepEqual(tabChange(state, "notes"), { activeTab: "reader", sidePanel: "notes" });
  assert.deepEqual(tabChange(state, "reader"), { activeTab: "reader" });
  assert.deepEqual(tabChange(state, "sticky-notes"), { activeTab: "sticky-notes", focusMode: false });
  assert.deepEqual(tabChange(state, "references"), { activeTab: "references", focusMode: false });
  // Anything else stays as it is rather than hiding the reader in focus mode.
  assert.deepEqual(tabChange(state, "settings"), {});
});

test("text handed over from the reader opens in the side panel, with the reader shown", () => {
  for (const panel of SIDE_PANELS) assert.deepEqual(openBesideReader(panel), { activeTab: "reader", sidePanel: panel });
});

test("a finished 解説 opens beside the PDF when the side panel is open there, and never hides the PDF", () => {
  // Already there: nothing to do.
  assert.equal(summaryPlacement({ activeTab: "reader", sidePanel: "summary" }), "none");
  // Reading with the chat or memo beside the PDF: the panel switches to the 解説.
  assert.equal(summaryPlacement({ activeTab: "reader", sidePanel: "chat" }), "panel");
  assert.equal(summaryPlacement({ activeTab: "reader", sidePanel: "notes" }), "panel");
  // No panel, or another tab shown: its tab, as before (in focus mode tabChange puts it beside the PDF).
  assert.equal(summaryPlacement({ activeTab: "reader", sidePanel: null }), "tab");
  assert.equal(summaryPlacement({ activeTab: "notes", sidePanel: "summary" }), "tab");
  assert.deepEqual(tabChange({ activeTab: "reader", focusMode: true, sidePanel: null }, "summary"), { activeTab: "reader", sidePanel: "summary" });
});

test("only the three panes can be side panels", () => {
  assert.ok(isSidePanel("chat"));
  assert.ok(!isSidePanel("reader"));
  assert.ok(!isSidePanel("sticky-notes"));
  assert.ok(!isSidePanel(null));
});

test("the place kept for a paper is rounded, and none at the top of the page", () => {
  assert.equal(savedAnchor(0, 0.4), null);
  assert.equal(savedAnchor(120, null), null);
  assert.equal(savedAnchor(120, 0.123456), 0.123);
  assert.equal(savedAnchor(120, 1.5), 1);
  assert.equal(savedAnchor(120, 0.0001), null);
  assert.equal(savedAnchor(120, Number.NaN), null);
});

test("places read back from ui-state.json keep only fractions of a page", () => {
  assert.deepEqual(parseAnchors({ a: 0.5, b: 0, c: 2, d: "0.3", e: Number.POSITIVE_INFINITY, f: 1 }), { a: 0.5, f: 1 });
  assert.deepEqual(parseAnchors(undefined), {});
  assert.deepEqual(parseAnchors([0.5]), {});
});

test("saved places are merged with those set while waiting for the sidecar, dropping any whose page was turned meanwhile", () => {
  const merged = mergeSavedAnchors({
    saved: { kept: 0.4, turned: 0.6, same: 0.2, rescrolled: 0.9, bad: "x" },
    savedPages: { kept: 3, turned: 5, same: 2, rescrolled: 7 },
    // `turned` was opened on another page; `same` was opened on its saved page; `rescrolled` was scrolled.
    pages: { turned: 6, same: 2, rescrolled: 7 },
    anchors: { rescrolled: 0.1 },
  });
  assert.deepEqual(merged, { kept: 0.4, same: 0.2, rescrolled: 0.1 });
  assert.deepEqual(mergeSavedAnchors({ saved: undefined, savedPages: {}, pages: {}, anchors: {} }), {});
});

test("an element in an inert or hidden part of the page is not on screen", () => {
  const element = (inert: boolean, visible: boolean | undefined) => ({
    closest: (selector: string) => (selector === "[inert]" && inert ? {} : null),
    checkVisibility: visible === undefined ? undefined : () => visible,
  }) as unknown as Element;
  assert.ok(onScreen(element(false, true)));
  assert.ok(!onScreen(element(true, true)));
  assert.ok(!onScreen(element(false, false)));
  // Browsers without checkVisibility go by inert alone.
  assert.ok(onScreen(element(false, undefined)));
});
