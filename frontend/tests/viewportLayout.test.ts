import assert from "node:assert/strict";
import { test } from "node:test";
import { viewportLayout } from "../src/features/references/viewportLayout.ts";
import { nodeRadius, citationScope, type MapGroup } from "../src/features/references/mapLayout.ts";
import type { MapNode } from "../src/features/references/mapGraph.ts";

test("viewport packing fits varied community counts, citation sizes and degenerate saved shapes", () => {
  for (const sizes of [[29], [20, 4, 3, 2], Array(14).fill(2) as number[], [7, 7, 7, 7, 7, 7, 7, 10]]) {
    const count = sizes.reduce((a, b) => a + b), nodes: MapNode[] = Array.from({ length: count + 1 }, (_, i) => ({
      id: i ? `p${i}` : "root", paper_id: null, title: "Unrelated subject", year: "", first_author: "", doi: "", arxiv_id: "", abstract: "", url: "", external_id: "",
      external_citations: i % 3 === 0 ? null : i % 3 === 1 ? 0 : 1e8, local_citations: 0, roles: [], reasons: [], score: 0,
      prior_count: 0, following_count: 0, reference_id: null, research_key: "", provenance: [], acquired_at: "",
    }));
    let offset = 1;
    const groups: MapGroup[] = sizes.map((size, i) => {
      const members = nodes.slice(offset, offset + size).map(n => n.id); offset += size;
      return { id: `g${i}`, members, label: "区間解析と不確実性を含む制御設計", representative: "", color: "blue" };
    });
    const saved = Object.fromEntries(nodes.map((n, i) => [n.id, { x: i * 500, y: i * 500 }]));
    const packed = viewportLayout(nodes, groups, saved, "root", 831, 400, {}), scope = citationScope(nodes);
    const circles = nodes.map(n => ({ id: n.id, x: 831 / 2 + packed.camera.x + packed.positions[n.id].x * packed.camera.zoom,
      y: 400 / 2 + packed.camera.y + packed.positions[n.id].y * packed.camera.zoom,
      radius: Math.max(n.id === "root" ? 14 : 8, nodeRadius(n, scope) * (packed.camera.zoom >= 1 ? packed.camera.zoom : Math.sqrt(packed.camera.zoom))) }));
    assert.deepEqual(packed.positions.root, { x: 0, y: 0 });
    assert.deepEqual(saved.p1, { x: 500, y: 500 }, "saved coordinates are not mutated");
    for (const c of circles) {
      assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y));
      assert.ok(c.x - c.radius >= 4 && c.x + c.radius <= 827 && c.y - c.radius >= 4 && c.y + c.radius <= 396, `node ${c.id} fits ${sizes}`);
    }
    for (let i = 0; i < circles.length; i++) for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i], b = circles[j];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius + 4, `node circles remain separate: ${sizes}`);
    }
  }
});
