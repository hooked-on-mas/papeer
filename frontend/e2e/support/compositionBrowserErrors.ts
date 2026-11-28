import assert from 'node:assert/strict';

export type CorpusNavigationError = {
  engine: 'chromium' | 'webkit'; host: string; stage: string; origin: string;
  departingController: string | undefined; stack: string;
};

/** Proven by webkitCorpusNavigation.mjs using the production corpus/session.
 * WebKit reports the second read as pageerror even though the corpus catches it.
 * This is a fixture HTTP navigation diagnostic; unhandled rejections remain independent failures.
 */
export function isCaughtCorpusNavigationError({ engine, host, stage, origin, departingController, stack }: CorpusNavigationError): boolean {
  const departing = departingController === 'reader/DocumentLibraryConnection' || departingController === 'notes/MarkdownLibraryConnection';
  if (engine !== 'webkit' || host !== 'native' || stage !== 'reload-native' || !departing) return false;
  const corpus = stack.startsWith(`Fetch API cannot load ${origin}/api/edits/read due to access control checks.\n`)
    && stack.includes(`    at request (${origin}/e2e/fixtures/documentComposition.tsx:`)
    && stack.includes(`    at read (${origin}/src/features/library/annotations/canonicalAnnotationCorpus.ts:`);
  // Exact R17 handled navigation aborts: keep the full stacks as diagnostics.
  // HTTP/auth failures and unhandled rejections are not this WebKit signature.
  const wire = /^    at unknown \(web-inspector:\/\/bootstrap\.js:\d+:\d+\)$/m.test(stack)
    && stack.includes(`    at wire (${origin}/src/adapters/desktop/bootstrapHostDriver.ts:`);
  const pending = stack.startsWith(`Fetch API cannot load ${origin}/api/edits/pending-records due to access control checks.\n`);
  const providerFlush = stack.startsWith(`Fetch API cannot load ${origin}/api/edits/provider-owner/replication/flush due to access control checks.\n`)
    && stack.includes(`    at startPass (${origin}/src/adapters/desktop/provider/providerOwner.ts:`)
    && stack.includes(`    at settled (${origin}/src/adapters/desktop/provider/providerOwner.ts:`);
  // R24's wire-only read has exactly three frames/lines. Do not broaden the
  // existing corpus signature or accept extra operation/authority frames.
  const readLines = stack.split('\n');
  const readWirePrefix = `    at wire (${origin}/src/adapters/desktop/bootstrapHostDriver.ts:`;
  const wireRead = readLines.length === 3
    && readLines[0] === `Fetch API cannot load ${origin}/api/edits/read due to access control checks.`
    && /^    at unknown \(web-inspector:\/\/bootstrap\.js:\d+:\d+\)$/.test(readLines[1])
    && readLines[2].startsWith(readWirePrefix)
    && /^\d+:\d+\)$/.test(readLines[2].slice(readWirePrefix.length));
  // Exact wrapped signature reproduced with the actual fixture fetch boundary
  // and caught Promise continuation; standalone run-r3 also checks HTTP/unhandled controls.
  const fetcherPrefix = `    at fetcher (${origin}/e2e/fixtures/documentComposition.tsx:`;
  const wrappedWireRead = readLines.length === 4
    && readLines[0] === `Fetch API cannot load ${origin}/api/edits/read due to access control checks.`
    && /^    at unknown \(web-inspector:\/\/bootstrap\.js:\d+:\d+\)$/.test(readLines[1])
    && readLines[2].startsWith(fetcherPrefix)
    && /^\d+:\d+\)$/.test(readLines[2].slice(fetcherPrefix.length))
    && readLines[3].startsWith(readWirePrefix)
    && /^\d+:\d+\)$/.test(readLines[3].slice(readWirePrefix.length));
  return corpus || wireRead || wrappedWireRead || wire && (pending || providerFlush);
}

export type CompositionBrowserObservations = {
  forbidden: readonly string[]; errors: readonly string[]; unhandled: readonly string[]; navigationDiagnostics: readonly string[];
};

export function assertCompositionBrowserObservations(observations: CompositionBrowserObservations): void {
  // Every assertion includes every collection, so an earlier failure never hides unhandled rejections.
  const detail = `Composition browser observations: ${JSON.stringify(observations)}`;
  assert.deepEqual(observations.forbidden, [], detail);
  assert.deepEqual(observations.errors, [], detail);
  assert.deepEqual(observations.unhandled, [], detail);
}
