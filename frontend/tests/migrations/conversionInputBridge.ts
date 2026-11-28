// Python extraction -> TypeScript conversion bridge (run by tests/providers/drive/test_native_conversion_input_ts.py;
// not a *.test.* file). Run directly, without Vite:  node --experimental-transform-types tests/migrations/conversionInputBridge.ts
// stdin : { "manifest": {...}, "extractions": [{ "libraryId", "sourceDocumentId", "entry", "bytesBase64", "annotations" }] }
// stdout: { "notebooks": [{ sourceDocumentId, status, reason | counts + pageMappings }], "wholeLibrary": {...} }
// A failure exits 1 with {"error": "<closed code>"} on stderr. Nothing here reads a Library or writes anything.
import { projectConversionInputNotebooks, type NotebookExtraction } from '../../src/migrations/legacyConversionInput.ts';

/** Strict base64, like the preview: the Python encoder never emits whitespace or a missing pad. */
function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('bridge-bytes-invalid');
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { manifest: unknown; extractions: Record<string, unknown>[] };
  const extractions = new Map<string, NotebookExtraction>();
  for (const item of input.extractions) {
    const { bytesBase64, ...rest } = item;
    extractions.set(String(item.sourceDocumentId), { ...rest, bytes: decodeBase64(bytesBase64) } as unknown as NotebookExtraction);
  }
  const result = await projectConversionInputNotebooks(input.manifest, extractions);
  process.stdout.write(JSON.stringify({
    notebooks: result.notebooks.map(item => item.status === 'converted'
      ? { sourceDocumentId: item.sourceDocumentId, status: item.status, counts: item.counts, pageMappings: item.pageMappings,
        pageAnnotationKinds: item.document.pages.map(page => page.annotations.map(annotation => annotation.kind)) }
      : { sourceDocumentId: item.sourceDocumentId, status: item.status, reason: item.reason }),
    wholeLibrary: result.wholeLibrary,
  }));
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'bridge-failed' }));
  process.exitCode = 1;
}
