import assert from "node:assert/strict";
import { test } from "node:test";
import { citationScope, citationCount, nodeRadius, mapGroups, mapPositions, groupOutline, reconcileMapLayout } from "../src/features/references/mapLayout.ts";
import type { MapNode, MapEdge } from "../src/features/references/mapGraph.ts";
import type { MapGroup } from "../src/features/references/mapLayout.ts";

const node = (id: string, count: number | null = null): MapNode => ({ id, paper_id: null, title: `A research paper ${id}`, year: "2020", first_author: "", doi: "", arxiv_id: "", abstract: "", url: "", external_id: "",
  external_citations: count, local_citations: 0, roles: [], reasons: [], score: 0, prior_count: 0, following_count: 0, reference_id: null, research_key: id, provenance: [], acquired_at: "" });
const link = (source: string, target: string): MapEdge => ({ source, target, kind: "citation", provenance: "fixture" });
const peers = ["a", "b", "c", "d", "e", "f"].map(id => node(id, 100));
const edges = [link("a", "b"), link("b", "c"), link("a", "c"), link("d", "e"), link("e", "f"), link("d", "f"), link("c", "d"), ...peers.map(n => link("root", n.id))];

test("size increases with citations with a bound; missing external counts never use local counts", () => {
  const nodes = [node("zero", 0), node("medium", 100), node("high", 10000), { ...node("unknown"), local_citations: 10000 }];
  assert.equal(citationScope(nodes), "external");
  assert.ok(nodeRadius(nodes[0], "external") < nodeRadius(nodes[1], "external"));
  assert.ok(nodeRadius(nodes[1], "external") < nodeRadius(nodes[2], "external"));
  assert.ok(nodeRadius(node("huge", 1e12), "external") <= 34);
  assert.equal(citationCount(nodes[3], "external"), null);
  assert.equal(nodeRadius(nodes[3], "external"), nodeRadius(nodes[0], "external"));
  assert.equal(citationScope([nodes[3]]), "local");
  assert.equal(citationCount(nodes[3], "local"), 10000);
});

test("weak bridges preserve two dense groups; origin's universal citation does not make one group", () => {
  const groups = mapGroups([node("root"), ...peers], edges, "root");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.members), [["a", "b", "c"], ["d", "e", "f"]]);
  assert.deepEqual(groups, mapGroups([...peers].reverse(), [...edges].reverse(), "root"));
  assert.deepEqual(mapGroups([node("root"), ...peers], peers.map(n => link("root", n.id)), "root"), []);
});

test("shared citation evidence outside displayed nodes can group papers without adding fake graph edges", () => {
  const evidence = [link("a", "x"), link("a", "y"), link("b", "x"), link("b", "y")];
  const groups = mapGroups([node("root"), node("a"), node("b")], evidence, "root");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members, ["a", "b"]);
  assert.deepEqual(evidence, [link("a", "x"), link("a", "y"), link("b", "x"), link("b", "y")]);
  assert.deepEqual(mapGroups([node("a"), node("b")], evidence.map(e => ({ ...e, kind: "recommendation" })), "root"), []);
});

test("dense highly cited nodes stay separated, groups remain distinct and incremental results retain coordinates", () => {
  const nodes = [node("root", 0), ...Array.from({ length: 20 }, (_, i) => node(`n${i}`, 100000))];
  const links = nodes.slice(1).flatMap((n, i) => nodes.slice(i + 2).filter((_, j) => Math.floor(i / 5) === Math.floor((i + j + 1) / 5)).map(other => link(n.id, other.id)));
  const groups = mapGroups(nodes, links, "root");
  const positions = mapPositions(nodes, "root", {}, links, groups);
  assert.deepEqual(positions, mapPositions(nodes, "root", {}, links, groups));
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = positions[nodes[i].id], b = positions[nodes[j].id];
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > nodeRadius(nodes[i], "external") + nodeRadius(nodes[j], "external") + 30);
  }
  const augmented = mapPositions([...nodes, node("new")], "root", positions, [...links, link("n1", "new")]);
  for (const n of nodes) assert.deepEqual(augmented[n.id], positions[n.id]);
  const outline = groupOutline(groups[0], positions, 55)!;
  assert.ok(outline.path.startsWith("M ") && outline.path.endsWith(" Z"));
  assert.ok(!outline.path.includes("NaN"));
});

test("whole group regions stay disjoint even with numerous cross-group citation links", () => {
  const nodes = [node("root", 0), ...Array.from({ length: 28 }, (_, i) => node(`p${i}`, i * 100))];
  const groups: MapGroup[] = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, label: `Group ${i}`, color: "blue",
    representative: "Fixture", members: nodes.slice(1 + i * 7, 8 + i * 7).map(n => n.id) }));
  const links = nodes.slice(1).flatMap((n, i) => nodes.slice(i + 2).map(other => link(n.id, other.id)));
  const positions = mapPositions(nodes, "root", {}, [...links, ...nodes.slice(1).map(n => link("root", n.id))], groups);
  const boxes = groups.map(g => ({
    left: Math.min(...g.members.map(id => positions[id].x)) - 50, right: Math.max(...g.members.map(id => positions[id].x)) + 50,
    top: Math.min(...g.members.map(id => positions[id].y)) - 75, bottom: Math.max(...g.members.map(id => positions[id].y)) + 50,
  }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
  }
  assert.deepEqual(positions.root, { x: 0, y: 0 });
  assert.deepEqual(mapPositions(nodes, "root", positions, links, groups), positions);
});

test("progressive citations repair interleaved saved communities once, without using names or topics", () => {
  for (const sizes of [[11, 9, 6, 3], [2, 2, 2, 2, 2, 2, 2, 2], [23, 4, 2], [15, 15, 15, 14]]) {
    const nodes = [node("root"), ...Array.from({ length: sizes.reduce((a, b) => a + b) }, (_, i) => node(`p${i}`, i % 3 ? 50000 : null))];
    let offset = 1;
    const groups: MapGroup[] = sizes.map((count, i) => {
      const members = nodes.slice(offset, offset + count).map(n => n.id); offset += count;
      return { id: `g${i}`, label: `Unrelated subject ${i}`, color: "blue", representative: "", members };
    });
    const links = groups.flatMap(g => g.members.flatMap((id, i) => g.members.slice(i + 1).map(target => link(id, target))));
    const initial = reconcileMapLayout(nodes.map(n => ({ ...n, external_citations: null })), "root", {}, nodes.slice(1).map(n => link("root", n.id)), []);
    // Simulate saved coordinates from partial evidence, including a crowded center.
    const saved = Object.fromEntries(nodes.map((n, i) => [n.id, { x: i % 5 * 20, y: Math.floor(i / 5) * 20 }]));
    const repaired = reconcileMapLayout(nodes, "root", saved, links, groups, initial.key);
    assert.equal(repaired.reflowed, true);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = repaired.positions[nodes[i].id], b = repaired.positions[nodes[j].id];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > nodeRadius(nodes[i], "external") + nodeRadius(nodes[j], "external") + 30);
    }
    const repeated = reconcileMapLayout(nodes, "root", repaired.positions, links, groups, repaired.key);
    assert.equal(repeated.reflowed, false); assert.deepEqual(repeated.positions, repaired.positions);
    const dragged = { ...repaired.positions, p0: { x: 813, y: 299 } };
    assert.deepEqual(reconcileMapLayout(nodes, "root", dragged, links, groups, repaired.key).positions.p0, dragged.p0);
  }
});

test("adding a distant paper keeps valid coordinates and names alone do not reflow geometry", () => {
  const nodes = [node("root"), ...peers], groups = mapGroups(nodes, edges, "root");
  const first = reconcileMapLayout(nodes, "root", {}, edges, groups);
  const saved = { ...first.positions, distant: { x: 5000, y: 5000 } };
  const added = reconcileMapLayout([...nodes, node("distant")], "root", saved, edges, groups, first.key);
  assert.equal(added.reflowed, false); assert.deepEqual(added.positions, saved);
  assert.equal(reconcileMapLayout(nodes, "root", first.positions, edges, groups.map(g => ({ ...g, label: "A different name" })), first.key).key, first.key);
});
