import assert from "node:assert/strict";
import { test } from "node:test";
import { externalCitationSource, externalCitationSources, localMap, mapRows, mapWindow, mapPositions, newView, type MapNode, type MapResult } from "../src/features/references/mapGraph.ts";

const node = (id: string, roles: MapNode["roles"], registered = false): MapNode => ({ id, paper_id: registered ? id : null, title: `Paper ${id}`, year: "2020", first_author: "Smith", doi: `10.1234/${id}`, arxiv_id: "", abstract: "", url: "", external_id: "", external_citations: null, local_citations: 0, roles, reasons: [], score: 1, prior_count: 0, following_count: 0, reference_id: null, research_key: id, provenance: [], acquired_at: "" });
const result: MapResult = { origin: "root", nodes: [node("root", [], true), ...Array.from({ length: 100 }, (_, i) => node(`direct${i}`, ["references"], i % 2 === 0)), ...Array.from({ length: 20 }, (_, i) => node(`close${i}`, ["related"], true))], edges: [], references: [], warnings: [], coverage: "fixture", checked_at: "", stale: false };

test("external citation counts label the current provider and saved legacy provider", () => {
  const semantic = { ...node("local", []), external_id: "https://www.semanticscholar.org/paper/" + "a".repeat(40), external_citations: 12 };
  const legacy = { ...semantic, external_id: "https://openalex.org/W123" };
  assert.equal(externalCitationSource(semantic), "Semantic Scholar");
  assert.equal(externalCitationSource(legacy), "OpenAlex（保存済み）");
  assert.equal(externalCitationSources([semantic, semantic]), "Semantic Scholar");
  assert.equal(externalCitationSources([semantic, legacy]), "Semantic Scholar・OpenAlex（保存済み）");
});

test("map limits only the diagram, reserves related slots, and includes selection and origin", () => {
  const view = { ...newView("root"), selected: "direct99" };
  const rows = mapRows(result, view);
  const window = mapWindow(result, rows, view);
  assert.equal(window.nodes.length, 60);
  assert.equal(window.nodes.filter(n => n.roles.includes("related")).length, 15);
  assert.ok(window.nodes.some(n => n.id === view.selected));
  assert.ok(window.nodes.some(n => n.id === result.origin));
  assert.equal(rows.length, 120);
  assert.equal(window.omitted, 61);
});

test("one registration filter and metadata search also work for related papers", () => {
  const view = { ...newView("root"), mode: "related" as const, filter: "registered" as const, search: "10.1234/close1" };
  assert.equal(mapRows(result, view).length, 11);
  assert.equal(mapRows(result, { ...view, filter: "external" }).length, 0);
});

test("automatic small maps leave most room for topic-relevant direct references", () => {
  const excavation = { ...node("excavation", ["references"]), score: .7 };
  const data = { ...result, nodes: [...result.nodes.map(n => ({ ...n, score: 0 })), excavation] };
  const view = newView("root");
  for (const limit of [20, 30]) {
    const diagram = mapWindow(data, mapRows(data, view), view, limit);
    assert.ok(diagram.nodes.some(n => n.id === "excavation"));
    assert.ok(diagram.nodes.filter(n => n.roles.includes("references")).length >= Math.floor((limit - 1) * 2 / 3));
    assert.ok(diagram.nodes.filter(n => n.roles.includes("related")).length <= Math.ceil((limit - 1) / 3));
  }
});

test("new candidates retain existing node positions", () => {
  const first = mapPositions(result.nodes.slice(0, 10), result.origin, {});
  first.direct0 = { x: 813, y: 299 };
  const next = mapPositions(result.nodes, result.origin, first);
  assert.deepEqual(next.direct0, first.direct0);
  assert.deepEqual(next.root, first.root);
  assert.equal(Object.keys(next).length, result.nodes.length);
});

test("prior and following sort by unique neighborhood count with newer following work first", () => {
  const a = { ...node("a", ["prior", "following"]), prior_count: 4, following_count: 3, year: "2022" };
  const b = { ...node("b", ["prior", "following"]), prior_count: 2, following_count: 3, year: "2024" };
  const data = { ...result, nodes: [a, b] };
  assert.equal(mapRows(data, { ...newView("root"), mode: "prior" })[0].id, "a");
  assert.equal(mapRows(data, { ...newView("root"), mode: "following" })[0].id, "b");
});

const network = { ...result, nodes: [node("root", []), node("a", ["references"]), node("b", ["references"]), node("c", ["related"])],
  edges: [{ source: "root", target: "a", kind: "citation" as const, provenance: "library" },
    { source: "root", target: "b", kind: "citation" as const, provenance: "library" },
    { source: "a", target: "c", kind: "citation" as const, provenance: "library" },
    { source: "b", target: "c", kind: "citation" as const, provenance: "library" }] };

test("shared second-hop references are discoverable offline without a fake origin edge", () => {
  const data = localMap({ nodes: network.nodes, edges: [...network.edges, network.edges[2]], references: [], warnings: [] }, "root");
  const shared = data.nodes.find(n => n.id === "c")!;
  assert.ok(shared.roles.includes("related"));
  assert.ok(shared.reasons.includes("直接の参考文献のうち2件が引用"));
  assert.equal(shared.prior_count, 2);
  assert.ok(!data.edges.some(e => e.source === "root" && e.target === "c"));
});

test("related mode preserves the real citation paths with context bibliography nodes", () => {
  const view = { ...newView("root"), mode: "related" as const };
  const rows = mapRows(network, view);
  const diagram = mapWindow(network, rows, view);
  assert.deepEqual(rows.map(n => n.id), ["c"]);
  assert.equal(diagram.context, 2);
  assert.equal(diagram.edges.length, 4);
  assert.equal(diagram.nodes.length, 4);
  assert.equal(diagram.omitted, 0);
  const withUnrelated = { ...network, nodes: [...network.nodes, node("unrelated-direct", ["references"])],
    edges: [...network.edges, { source: "root", target: "unrelated-direct", kind: "citation" as const, provenance: "library" }] };
  assert.equal(mapWindow(withUnrelated, mapRows(withUnrelated, view), view).context, 2);
  assert.equal(mapWindow(withUnrelated, [], { ...view, search: "no matching results" }).context, 0);
});

test("context capacity first preserves the selected foundation's path", () => {
  const peers = Array.from({ length: 20 }, (_, i) => node(`peer${i}`, ["references"]));
  const ancestors = Array.from({ length: 10 }, (_, i) => node(`ancestor${i}`, ["related"]));
  const data = { ...result, nodes: [node("root", []), ...peers, ...ancestors], edges: peers.map(n => ({ source: "root", target: n.id, kind: "citation" as const, provenance: "library" }))
    .concat(peers.map((n, i) => ({ source: n.id, target: `ancestor${Math.floor(i / 2)}`, kind: "citation" as const, provenance: "library" }))) };
  const view = { ...newView("root"), mode: "related" as const, selected: "ancestor9" };
  const diagram = mapWindow(data, mapRows(data, view), view, 24);
  assert.equal(diagram.context, 14);
  assert.ok(diagram.nodes.some(n => n.id === "peer18"));
  assert.ok(diagram.nodes.some(n => n.id === "peer19"));
});

test("limited nearby diagrams retain bibliography nodes that connect shared foundations", () => {
  const data = { ...network, nodes: [node("root", []), ...Array.from({ length: 20 }, (_, i) => node(`unconnected${i}`, ["references"])), ...network.nodes.slice(1)] };
  const view = newView("root");
  const diagram = mapWindow(data, mapRows(data, view), view, 4);
  assert.equal(diagram.nodes.length, 4);
  assert.ok(diagram.nodes.some(n => n.id === "a"));
  assert.ok(diagram.nodes.some(n => n.id === "b"));
  assert.equal(diagram.edges.length, 4);
});

test("citation layout groups connected papers and preserves saved coordinates as results arrive", () => {
  const nodes = [...network.nodes, node("unconnected", [])];
  const arranged = mapPositions(nodes, "root", {}, network.edges);
  const distance = (a: string, b: string) => Math.hypot(arranged[a].x - arranged[b].x, arranged[a].y - arranged[b].y);
  assert.ok(distance("a", "c") < distance("a", "unconnected"));
  assert.deepEqual(arranged.root, { x: 0, y: 0 });
  assert.deepEqual(arranged, mapPositions(nodes, "root", {}, network.edges));
  const saved: typeof arranged = { ...arranged, a: { x: 800, y: 300 } };
  const next = mapPositions([...nodes, node("new", ["related"])], "root", saved,
    [...network.edges, { source: "a", target: "new", kind: "citation", provenance: "library" }]);
  for (const n of nodes) assert.deepEqual(next[n.id], saved[n.id]);
  assert.ok(Math.hypot(next.new.x - saved.a.x, next.new.y - saved.a.y) < 250);
});
