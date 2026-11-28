// Run with node --expose-gc scripts/benchmark-edit-graph.mjs. Synthetic, storage-free.
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { editGraphHistoryFixture } from '../tests/support/editGraphHistoryFixture.ts';

for (const count of [80, 160, 320]) {
  const checkpoint = editGraphHistoryFixture(count);
  globalThis.gc?.(); const before = process.memoryUsage().heapUsed, start = performance.now();
  const graph = new EditGraph(checkpoint);
  const buildMs = performance.now() - start;
  globalThis.gc?.(); const retainedBytes = process.memoryUsage().heapUsed - before;
  const replayStart = performance.now();
  const restarted = new EditGraph(graph.checkpoint());
  const restartMs = performance.now() - replayStart;
  const incremental = new EditGraph({ ...checkpoint, batches: [] }), incrementStart = performance.now();
  for (const batch of checkpoint.batches) incremental.receive([batch]);
  const incrementalMs = performance.now() - incrementStart;
  console.log(JSON.stringify({ count, points: count * 20, buildMs, restartMs, incrementalMs, retainedBytes,
    head: restarted.getView().heads[0] === incremental.getView().heads[0] }));
}
