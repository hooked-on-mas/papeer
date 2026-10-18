import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizeProposal } from "../src/api/jobTypes.ts";
import {
  allOrganizable, applyPayload, commonFolder, createdFolders, destinationChoices, draftEdited, draftFromProposal,
  isMoving, movingMoves, organizableCounts, organizableIds, organizableItems, organizeCandidates, organizeRows, papersDirectlyIn,
  proposalFromDraft, renameNewFolder, setDestination, setIncluded, withAncestors, type OrganizeDraft, type OrganizeRow,
} from "../src/features/library/organizePlan.ts";
import { paperData } from "./support/paperData.ts";

const proposal: OrganizeProposal = {
  source: "",
  instruction: "研究分野別に",
  folders: [
    { name: "強化学習", reason: "報酬から方策を学ぶ研究", new: true },
    { name: "制御 / モデル予測制御", reason: "MPC に関する論文", new: true },
    { name: "Vision", reason: "既存のフォルダー", new: false },
  ],
  moves: [
    { paper_id: "a", title: "Policy gradient", from: "", to: "強化学習" },
    { paper_id: "b", title: "Q-learning", from: "", to: "強化学習" },
    { paper_id: "c", title: "Linear MPC", from: "", to: "制御 / モデル予測制御" },
    { paper_id: "d", title: "ResNet", from: "Inbox", to: "Vision" },
  ],
  expected: { a: "", b: "", c: "", d: "Inbox" },
  message: "4件を3つのフォルダーに分けました。",
};
const existing = withAncestors(["Vision", "Inbox", "制御"]);
const draft = () => draftFromProposal(proposal);

/** The rows as "folder(moving)" and the papers' ids under them, indented by depth, to compare at a glance. */
function outline(rows: OrganizeRow[]): string[] {
  return rows.map((row) => "  ".repeat(row.depth) + (row.kind === "folder" ? `${row.name}${row.isNew ? "*" : ""}(${row.moving})` : row.move.paperId));
}

test("with nothing changed, applying sends every proposed move with the folders it was proposed from", () => {
  assert.deepEqual(applyPayload(draft()), {
    moves: [{ paper_id: "a", to: "強化学習" }, { paper_id: "b", to: "強化学習" }, { paper_id: "c", to: "制御 / モデル予測制御" }, { paper_id: "d", to: "Vision" }],
    expected: { a: "", b: "", c: "", d: "Inbox" },
  });
  assert.equal(draftEdited(draft()), false);
});

test("a paper left out, one sent elsewhere and a renamed new folder change the payload and nothing else", () => {
  let next = setIncluded(draft(), ["b"], false);
  next = setDestination(next, "d", "Inbox / Papers");
  const renamed = renameNewFolder(next, "強化学習", "RL", existing);
  assert.ok("draft" in renamed);
  next = renamed.draft;
  assert.deepEqual(applyPayload(next), {
    moves: [{ paper_id: "a", to: "RL" }, { paper_id: "c", to: "制御 / モデル予測制御" }, { paper_id: "d", to: "Inbox / Papers" }],
    expected: { a: "", c: "", d: "Inbox" },
  });
  assert.equal(draftEdited(next), true);
  // The proposal's own draft is untouched.
  assert.equal(draft().moves.length, 4);
});

test("a paper sent where it already is does not move, even when checked", () => {
  const next = setDestination(draft(), "d", "Inbox");
  assert.equal(isMoving(next.moves[3]), false);
  assert.deepEqual(movingMoves(next).map((move) => move.paperId), ["a", "b", "c"]);
  assert.deepEqual(applyPayload(next).moves.map((move) => move.paper_id), ["a", "b", "c"]);
});

test("changing nothing gives the draft back, so that nothing renders again", () => {
  const base = draft();
  assert.equal(setIncluded(base, ["a"], true), base);
  assert.equal(setDestination(base, "a", "強化学習"), base);
  assert.equal(setDestination(base, "zzz", "強化学習"), base);
  const changed = setIncluded(base, ["a"], false);
  assert.notEqual(changed.moves, base.moves);
  assert.equal(changed.moves[1], base.moves[1], "the other papers keep their objects");
});

test("destinations are normalized like folder paths", () => {
  const next = setDestination(draft(), "a", " Vision/ 3D ");
  assert.equal(next.moves[0].to, "Vision / 3D");
});

test("renaming a new folder renames the new folders below it and the papers sent to them", () => {
  const base: OrganizeDraft = {
    ...draft(),
    folders: [...draft().folders, { name: "強化学習 / 深層", proposedName: "強化学習 / 深層", reason: "", isNew: true }],
    moves: [...draft().moves, { paperId: "e", title: "DQN", from: "", to: "強化学習 / 深層", proposedTo: "強化学習 / 深層", included: true }],
  };
  const result = renameNewFolder(base, "強化学習", "Reinforcement learning", existing);
  assert.ok("draft" in result);
  assert.deepEqual(result.draft.folders.map((folder) => folder.name),
    ["Reinforcement learning", "制御 / モデル予測制御", "Vision", "Reinforcement learning / 深層"]);
  assert.deepEqual(result.draft.moves.map((move) => move.to),
    ["Reinforcement learning", "Reinforcement learning", "制御 / モデル予測制御", "Vision", "Reinforcement learning / 深層"]);
  // Only the last name changes: a nested folder stays under its parent.
  const nested = renameNewFolder(base, "制御 / モデル予測制御", "MPC", existing);
  assert.ok("draft" in nested);
  assert.equal(nested.draft.moves[2].to, "制御 / MPC");
});

test("a new folder's name is refused when empty, taken (ignoring case), too long or . / ..", () => {
  const reason = (leaf: string, path = "強化学習") => {
    const result = renameNewFolder(draft(), path, leaf, existing);
    return "error" in result ? result.error : null;
  };
  assert.match(reason("  ") ?? "", /入力/);
  assert.match(reason("vision") ?? "", /同じ名前/);
  assert.match(reason("制御 / モデル予測制御") ?? "", /同じ名前/);
  assert.match(reason("..") ?? "", /使えません/);
  assert.match(reason("あ".repeat(81)) ?? "", /80文字/);
  assert.equal(reason("あ".repeat(80)), null);
  // Its own name is no change.
  assert.equal(reason("強化学習"), null);
  // Only a folder the proposal makes can be renamed.
  assert.match(reason("x", "Vision") ?? "", /変更できません/);
});

test("the rows nest destination folders under their parents, in the proposal's order, with 未分類 last", () => {
  const base = draft();
  assert.deepEqual(outline(organizeRows(base, existing)), [
    "強化学習*(2)", "  a", "  b",
    "制御(0)", "  モデル予測制御*(1)", "    c",
    "Vision(1)", "  d",
  ]);
  // A paper sent to 未分類 shows there, after the others.
  const withUnfiled = setDestination(base, "d", "");
  assert.deepEqual(outline(organizeRows(withUnfiled, existing)).slice(-2), ["未分類(1)", "  d"]);
  // 「制御」 holds no paper itself: shown for the place it gives, not as new (it exists).
  const control = organizeRows(base, existing).find((row) => row.kind === "folder" && row.path === "制御");
  assert.equal(control?.kind === "folder" && control.isNew, false);
  assert.deepEqual(control?.kind === "folder" ? control.paperIds : null, []);
});

test("a folder row counts the papers checked and the ones that would move", () => {
  const next = setIncluded(draft(), ["a"], false);
  const row = organizeRows(next, existing).find((r) => r.kind === "folder" && r.path === "強化学習");
  assert.ok(row?.kind === "folder");
  assert.deepEqual([row.paperIds.length, row.included, row.moving], [2, 1, 1]);
});

test("destination choices: 未分類, the existing folders, then the proposal's new ones", () => {
  assert.deepEqual(destinationChoices(draft(), ["Inbox", "Vision", "制御"]),
    ["", "Inbox", "Vision", "制御", "強化学習", "制御 / モデル予測制御"]);
});

test("the folders applying makes are the destinations that do not exist, with their parents", () => {
  assert.deepEqual(createdFolders(draft(), existing), ["強化学習", "制御 / モデル予測制御"]);
  const left = setIncluded(draft(), ["a", "b"], false);
  assert.deepEqual(createdFolders(left, existing), ["制御 / モデル予測制御"]);
  const deep = setDestination(draft(), "a", "新 / 親 / 子");
  assert.deepEqual(createdFolders(deep, existing), ["新", "新 / 親", "新 / 親 / 子", "強化学習", "制御 / モデル予測制御"]);
});

test("a revision starts from the proposal as it would be applied", () => {
  let next = setIncluded(draft(), ["b"], false);
  next = setDestination(next, "d", "Inbox");
  next = setDestination(next, "c", "Vision");
  const previous = proposalFromDraft(next);
  assert.deepEqual(previous.moves.map((move) => [move.paper_id, move.to]), [["a", "強化学習"], ["c", "Vision"]]);
  assert.deepEqual(previous.expected, { a: "", c: "" });
  assert.deepEqual(previous.folders.map((folder) => [folder.name, folder.new]), [["強化学習", true], ["Vision", false]]);
  assert.equal(previous.source, "");
  assert.equal(previous.instruction, "研究分野別に");
  assert.equal(previous.message, proposal.message);
});

test("a revision names a destination chosen from the existing folders, but not 未分類", () => {
  const next = setDestination(draft(), "d", "");
  const previous = proposalFromDraft(next);
  assert.deepEqual(previous.moves.find((move) => move.paper_id === "d")?.to, "");
  assert.equal(previous.folders.some((folder) => folder.name === ""), false);
  const chosen = setDestination(draft(), "a", "Inbox");
  assert.deepEqual(proposalFromDraft(chosen).folders.find((folder) => folder.name === "Inbox"), { name: "Inbox", reason: "", new: false });
});

test("the folder of a selection is the path its papers share", () => {
  assert.equal(commonFolder([]), "");
  assert.equal(commonFolder(["A / B"]), "A / B");
  assert.equal(commonFolder(["A / B / C", "A / B", "A / B / D"]), "A / B");
  assert.equal(commonFolder(["A / X", "A / Y"]), "A");
  assert.equal(commonFolder(["A", "B"]), "");
  assert.equal(commonFolder(["A", ""]), "");
  assert.equal(commonFolder(["A\\B", "A/B / C"]), "A / B");
});

test("an organization of a folder covers the papers directly in it, 未分類 being the ones without a folder", () => {
  const papers = [{ id: "1", collection_name: "A" }, { id: "2", collection_name: "A / B" }, { id: "3", collection_name: "" }, { id: "4" }];
  assert.deepEqual(papersDirectlyIn(papers, "A").map((p) => p.id), ["1"]);
  assert.deepEqual(papersDirectlyIn(papers, "").map((p) => p.id), ["3", "4"]);
  assert.deepEqual(papersDirectlyIn(papers, "A\\B").map((p) => p.id), ["2"]);
});

test("a parent the proposal does not name is a new folder too: renaming it renames the folders and papers below it", () => {
  // Only "制御 / RL" is named; its parent 制御 is made along with it.
  const base: OrganizeDraft = {
    source: "", instruction: "", message: "", expected: { x: "", y: "" },
    folders: [{ name: "制御 / RL", proposedName: "制御 / RL", reason: "", isNew: true }],
    moves: [
      { paperId: "x", title: "X", from: "", to: "制御 / RL", proposedTo: "制御 / RL", included: true },
      { paperId: "y", title: "Y", from: "", to: "制御", proposedTo: "制御", included: true },
    ],
  };
  const known = withAncestors(["Vision"]);
  const parent = organizeRows(base, known).find((row) => row.kind === "folder" && row.path === "制御");
  assert.ok(parent?.kind === "folder" && parent.isNew, "shown as new, so that it can be renamed");
  const result = renameNewFolder(base, "制御", "Control", known);
  assert.ok("draft" in result);
  assert.deepEqual(result.draft.moves.map((move) => move.to), ["Control / RL", "Control"]);
  assert.deepEqual(result.draft.folders.map((folder) => folder.name), ["Control / RL"]);
  assert.deepEqual(applyPayload(result.draft).moves, [{ paper_id: "x", to: "Control / RL" }, { paper_id: "y", to: "Control" }]);
  // The parent's new name is checked as well, though no folder of the proposal has it.
  const taken = renameNewFolder(base, "制御", "vision", known);
  assert.ok("error" in taken && /同じ名前/.test(taken.error));
  // The folder below it, renamed, stays under its parent.
  const nested = renameNewFolder(base, "制御 / RL", "強化学習", known);
  assert.ok("draft" in nested);
  assert.deepEqual(nested.draft.moves.map((move) => move.to), ["制御 / 強化学習", "制御"]);
});

test("an existing parent cannot be renamed, nor 未分類", () => {
  assert.ok("error" in renameNewFolder(draft(), "制御", "X", existing));
  assert.ok("error" in renameNewFolder(draft(), "", "X", existing));
});

test("only a set of papers one proposal can cover is offered for organizing", () => {
  assert.equal(organizableIds([]), null);
  assert.deepEqual(organizableIds(["a", "b", "a"]), ["a", "b"]);
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `p${i}`);
  assert.equal(organizableIds(ids(300))?.length, 300);
  assert.equal(organizableIds(ids(301)), null);
  // Counted without the repeats.
  assert.equal(organizableIds([...ids(300), "p0"])?.length, 300);
});

// A notebook has no text to sort by and the sidecar lists PDFs only, so a proposal never covers one.
const library = [
  paperData({ id: "p1", collection_name: "A" }),
  paperData({ id: "n1", collection_name: "A", kind: "notebook" }),
  paperData({ id: "p2", collection_name: "A / B" }),
  paperData({ id: "n2", collection_name: "", kind: "notebook" }),
  paperData({ id: "p3", collection_name: "" }),
];

test("an organization of a folder covers its PDFs, and says how many notebooks it leaves out", () => {
  const folder = organizeCandidates(library, { source: "A", paperIds: null });
  assert.deepEqual(folder.papers.map((p) => p.id), ["p1"]);
  assert.equal(folder.excluded, 1);
  // A folder of notebooks only has nothing to sort, though it lists items.
  const notebooks = organizeCandidates(library.filter((p) => p.id !== "p3"), { source: "", paperIds: null });
  assert.deepEqual(notebooks.papers, []);
  assert.equal(notebooks.excluded, 1);
});

test("the count a folder is offered with is the PDFs an organization of it covers", () => {
  const counts = organizableCounts(library);
  assert.deepEqual(Object.fromEntries(counts), { "": 1, A: 1, "A / B": 1 });
  for (const [folder, count] of counts) {
    assert.equal(organizeCandidates(library, { source: folder, paperIds: null }).papers.length, count, folder);
  }
  assert.equal(counts.get("Missing") ?? 0, 0);
});

test("a selection with a notebook in it is not organizable, and is not counted as PDFs only", () => {
  const mixed = library.filter((p) => ["p1", "n1", "p2"].includes(p.id));
  assert.equal(allOrganizable(mixed), false);
  const asked = organizeCandidates(library, { source: "", paperIds: ["p1", "n1", "p2"] });
  assert.deepEqual(asked.papers.map((p) => p.id), ["p1", "p2"]);
  assert.equal(asked.excluded, 1);
  // PDFs only, and a selection not loaded yet (no items), are as before.
  assert.equal(allOrganizable(library.filter((p) => p.kind === "pdf")), true);
  assert.equal(allOrganizable([]), true);
  assert.equal(organizeCandidates(library, { source: "", paperIds: ["p1", "p3"] }).excluded, 0);
  assert.deepEqual(organizableItems([{ kind: "later" }, { kind: "pdf" }, {}]), [{ kind: "pdf" }, {}]);
});
