// Python rows -> TypeScript staging plan bridge (work B7-e; the same way as conversionInputBridge.ts; not a *.test.* file).
// Run directly, without Vite:  node --experimental-transform-types tests/migrations/stagingConversionBridge.ts
// stdin : { "manifest": {...}, "extractions": [{ "libraryId", "sourceDocumentId", "entry", "bytesBase64", "annotations" }],
//           "rows": {B7-d `rows`}, "resources": [ResourceDescriptor], "webAnnotationOpsRows": <int> }
// stdout: the StagingPlan as JSON (units with their payloads, resources, ids, provenance, notConverted, residualReasons, coverage, counts, planSha256).
// A failure exits 1 with {"error": "<closed code>"} on stderr. Nothing here reads a Library or writes anything.
// In work B7 this bridge is the ONLY caller of the converters (decision J1): no route, CLI or start-up code uses them.
import { buildStagingPlan } from '../../src/migrations/legacyStagingConversion.ts';
import type { NotebookExtraction } from '../../src/migrations/legacyConversionInput.ts';
import { markdownImagePort } from '../support/stagingMarkdownPort.ts';

/** Strict base64, like the other bridges: the Python encoder never emits whitespace or a missing pad. */
function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('bridge-bytes-invalid');
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { manifest: unknown; extractions: Record<string, unknown>[]; rows: unknown; resources: unknown;
    webAnnotationOpsRows: unknown };
  const extractions = new Map<string, NotebookExtraction>();
  for (const item of input.extractions) {
    const { bytesBase64, ...rest } = item;
    extractions.set(String(item.sourceDocumentId), { ...rest, bytes: decodeBase64(bytesBase64) } as unknown as NotebookExtraction);
  }
  const plan = await buildStagingPlan({ manifest: input.manifest, extractions, rows: input.rows, resources: input.resources, webAnnotationOpsRows: input.webAnnotationOpsRows,
    markdownImages: markdownImagePort });
  process.stdout.write(JSON.stringify(plan));
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'bridge-failed' }));
  process.exitCode = 1;
}
