/** Topic-independent stress cases for desktop map inspection; never call services. */
import fs from "node:fs/promises";
import path from "node:path";
import { localMap, mapRows, mapWindow, newView } from "../src/features/references/mapGraph.ts";
import { mapGroups } from "../src/features/references/mapLayout.ts";
const directory = process.argv[2];
if (!directory) throw new Error("output directory required");
await fs.mkdir(directory, { recursive: true });
for (const [name, sizes] of Object.entries({ single: [29], uneven: [20, 4, 3, 2], many: Array(14).fill(2) as number[], sixty: [7, 7, 7, 7, 7, 7, 7, 10] })) {
  const origin = "a".repeat(32), count = sizes.reduce((a, b) => a + b);
  const nodes = [{ id: origin, paper_id: origin, title: name, year: "2024", url: "" },
    ...Array.from({ length: count }, (_, i) => ({ id: `ref:p${i}`, paper_id: null, title: `Independent study ${i}`, year: "2000", url: "" }))];
  const edges = nodes.slice(1).map(n => ({ source: origin, target: n.id }));
  let offset = 1;
  for (const size of sizes) {
    const members = nodes.slice(offset, offset + size); offset += size;
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) edges.push({ source: members[i].id, target: members[j].id });
  }
  const map = localMap({ nodes, edges, references: [], warnings: [] }, origin); map.stale = false;
  map.nodes.forEach((n, i) => { n.external_citations = i % 3 === 0 ? null : i % 3 === 1 ? 0 : 1e8; n.first_author = `Author${i}`; });
  const descriptions = new Map();
  for (const limit of [30, 60]) {
    const view = newView(origin), window = mapWindow(map, mapRows(map, view), view, limit);
    for (const [i, group] of mapGroups(window.nodes, map.edges, origin).entries()) descriptions.set(group.id + group.members.join(","), {
      key: group.id, members: group.members, name: i % 2 ? `区間解析と不確実性を含む制御設計 ${i}` : `General methods for uncertainty ${i}`,
      description: "Fixed inspection text", evidence: group.members.slice(0, 1), provider: "fixed", model: "fixed", elapsed_ms: 0, stale: false, created_at: "2026-10-05T00:00:00Z",
    });
  }
  await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(map));
  await fs.writeFile(path.join(directory, `${name}-groups.json`), JSON.stringify({ origin, groups: [...descriptions.values()], connection: "fixed" }));
}
