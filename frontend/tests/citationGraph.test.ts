import assert from "node:assert/strict";
import { test } from "node:test";
import { graphPositions, graphView, type CitationGraph } from "../src/features/references/graph.ts";

const graph: CitationGraph = {
  nodes: ["a", "b", "c", "external", "unrelated"].map((id) => ({ id, paper_id: id === "external" ? null : id, title: id, year: "2020", url: "" })),
  edges: [{ source: "a", target: "b" }, { source: "c", target: "a" }, { source: "a", target: "external" }, { source: "b", target: "c" }],
  references: [], warnings: [],
};

test("the neighbourhood includes incoming, outgoing and links between neighbours", () => {
  const view = graphView(graph, "a", "nearby", true);
  assert.deepEqual(new Set(view.nodes.map((node) => node.id)), new Set(["a", "b", "c", "external"]));
  assert.equal(view.edges.length, 4);
  assert.equal(graphView(graph, "external", "nearby", true).edges.length, 1);
});

test("library scope, external filter and cap never leave dangling edges", () => {
  assert.equal(graphView(graph, "a", "library", true).total, 5);
  assert.equal(graphView(graph, "a", "library", false).total, 4);
  const view = graphView(graph, "a", "library", true, 2);
  assert.equal(view.total, 5);
  assert.equal(view.nodes.length, 2);
  assert.equal(view.nodes[0].id, "a");
  assert.ok(view.edges.every((edge) => view.nodes.some((n) => n.id === edge.source) && view.nodes.some((n) => n.id === edge.target)));
});

test("positions are finite and distinct including no focus and a full network", () => {
  for (const center of ["a", null]) {
    const nodes = Array.from({ length: 60 }, (_, i) => ({ ...graph.nodes[0], id: i === 0 ? "a" : String(i) }));
    const positions = [...graphPositions(nodes, center).values()];
    assert.equal(positions.length, 60);
    assert.ok(positions.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
    assert.equal(new Set(positions.map(({ x, y }) => `${x},${y}`)).size, 60);
  }
});
