import assert from "node:assert/strict";
import { test } from "node:test";
import { citationIndex, graphPositions, graphView, relatedPapers, similarityPositions, similarityView, yearColor, type CitationGraph } from "../src/features/references/graph.ts";

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

test("related papers use common references and co-citation, not direct citations or duplicate rows", () => {
  const network: CitationGraph = { ...graph,
    nodes: ["a", "b", "c", "x", "y", "unrelated"].map(id => ({ ...graph.nodes[0], id })),
    edges: [{ source: "a", target: "x" }, { source: "a", target: "y" },
      { source: "b", target: "x" }, { source: "b", target: "y" }, { source: "b", target: "x" },
      { source: "c", target: "a" }, { source: "c", target: "b" }, { source: "a", target: "a" }],
  };
  const related = relatedPapers(network, "a");
  assert.deepEqual(related.map(item => item.node.id), ["b"]);
  assert.equal(related[0].sharedReferences, 2);
  assert.equal(related[0].sharedCitations, 1);
  assert.equal(related[0].score, 1);
  assert.equal(citationIndex(network).incoming.get("x")?.size, 2);
  assert.deepEqual(relatedPapers(network, null), []);
  const view = similarityView(network, "a", true);
  assert.deepEqual(view.nodes.map(node => node.id), ["a", "b"]);
  assert.deepEqual(view.edges, [{ source: "a", target: "b", weight: 1 }]);
  assert.deepEqual(similarityView(network, "a", true, 1).edges, []);
  const positions = similarityPositions(view.nodes, "a", view.edges);
  assert.deepEqual(positions, similarityPositions(view.nodes, "a", view.edges));
  assert.ok([...positions.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
});

test("unknown and identical publication years have stable colors", () => {
  assert.equal(yearColor("", graph.nodes), "var(--muted)");
  assert.equal(yearColor("2020", graph.nodes), yearColor("2020", graph.nodes));
  assert.ok(!yearColor("2020", graph.nodes).includes("NaN"));
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
