import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCaughtCorpusNavigationError, assertCompositionBrowserObservations,
  type CorpusNavigationError } from '../e2e/support/compositionBrowserErrors.ts';

const origin = 'http://127.0.0.1:49786';
// Exact failing r4 signature; line numbers are deliberately not part of the classification contract.
const stack = `Fetch API cannot load ${origin}/api/edits/read due to access control checks.\n`
  + `    at request (${origin}/e2e/fixtures/documentComposition.tsx:13:30)\n`
  + `    at unknown (${origin}/e2e/fixtures/documentComposition.tsx:136:22)\n`
  + `    at read (${origin}/src/features/library/annotations/canonicalAnnotationCorpus.ts:19:39)`;
const observed: CorpusNavigationError = { engine: 'webkit', host: 'native', stage: 'reload-native', origin,
  departingController: 'reader/DocumentLibraryConnection', stack };

test('only the proven native WebKit corpus reload signature is classified and its full stack is retained', () => {
  assert.equal(isCaughtCorpusNavigationError(observed), true);
  assert.equal(isCaughtCorpusNavigationError({ ...observed, departingController: 'notes/MarkdownLibraryConnection' }), true);
  assert.equal(isCaughtCorpusNavigationError({ ...observed, stack: stack.replace(':19:39)', ':119:7)') }), true);
  const navigationDiagnostics = [`native (reload-native): ${stack}`];
  assertCompositionBrowserObservations({ forbidden: [], errors: [], unhandled: [], navigationDiagnostics });
  assert.deepEqual(navigationDiagnostics, [`native (reload-native): ${stack}`]);
});

test('active views, other engines/hosts/stages and absent departing controllers remain errors', () => {
  const rejected: Partial<CorpusNavigationError>[] = [
    { engine: 'chromium' }, { host: 'web' }, { stage: 'active' }, { stage: 'opening' }, { stage: 'reload-web' },
    { departingController: undefined }, { departingController: '' }, { departingController: 'other/controller' },
  ];
  for (const change of rejected) assert.equal(isCaughtCorpusNavigationError({ ...observed, ...change }), false, JSON.stringify(change));
});

test('other origins, endpoints, source paths and frame identities remain errors', () => {
  const rejected = [
    stack.split(origin).join('http://127.0.0.1:49787'),
    stack.replace('/api/edits/read ', '/api/edits/pending-records '),
    stack.replace('/api/edits/read ', '/api/edits/read-resource '),
    stack.replace('due to access control checks.', 'failed for another reason.'),
    stack.replace('/e2e/fixtures/documentComposition.tsx:', '/e2e/fixtures/corpusNavigation.ts:'),
    stack.replace(`at request (${origin}`, `at unknown (${origin}`),
    stack.replace('/src/features/library/annotations/canonicalAnnotationCorpus.ts:', '/src/features/library/LibrarySession.ts:'),
    stack.replace(`at read (${origin}`, `at catalog (${origin}`),
    stack.replace(`at read (${origin}`, 'at read (http://127.0.0.1:49787'),
    stack.replace(`at request (${origin}`, 'at request (http://127.0.0.1:49787'),
  ];
  for (const candidate of rejected) assert.equal(isCaughtCorpusNavigationError({ ...observed, stack: candidate }), false, candidate);
});

test('a true unhandled rejection still fails alongside a classified navigation pageerror', () => {
  assert.equal(isCaughtCorpusNavigationError(observed), true);
  const observations = { forbidden: [], errors: [], unhandled: ['composition-unhandled:Error: genuine failure'],
    navigationDiagnostics: [`native (reload-native): ${stack}`] };
  assert.throws(() => assertCompositionBrowserObservations(observations), error => {
    assert.ok(error instanceof assert.AssertionError);
    assert.deepEqual(error.actual, observations.unhandled);
    assert.ok(error.message.includes(observations.unhandled[0]));
    assert.ok(error.message.includes('canonicalAnnotationCorpus.ts:19:39'));
    return true;
  });
});

test('the first assertion failure exposes errors, unhandled rejections and classified diagnostics together', () => {
  const observations = { forbidden: ['/api/legacy/read'], errors: ['active-view failure'],
    unhandled: ['composition-unhandled:Error: independent rejection'], navigationDiagnostics: [`native (reload-native): ${stack}`] };
  assert.throws(() => assertCompositionBrowserObservations(observations), error => {
    assert.ok(error instanceof assert.AssertionError);
    assert.deepEqual(error.actual, observations.forbidden);
    for (const values of Object.values(observations)) for (const value of values)
      assert.ok(error.message.includes(JSON.stringify(value).slice(1, -1)), value);
    return true;
  });
  assert.throws(() => assertCompositionBrowserObservations({ ...observations, forbidden: [] }), error => {
    assert.ok(error instanceof assert.AssertionError);
    assert.deepEqual(error.actual, observations.errors);
    assert.ok(error.message.includes(observations.unhandled[0]));
    return true;
  });
});


const wireAbort = (endpoint: string) => `Fetch API cannot load ${origin}${endpoint} due to access control checks.\n`
  + `    at unknown (web-inspector://bootstrap.js:703:125)\n`
  + `    at wire (${origin}/src/adapters/desktop/bootstrapHostDriver.ts:135:34)`;
const pendingAbort = wireAbort('/api/edits/pending-records');
const providerFlushAbort = wireAbort('/api/edits/provider-owner/replication/flush')
  + `\n    at startPass (${origin}/src/adapters/desktop/provider/providerOwner.ts:257:19)`
  + `\n    at settled (${origin}/src/adapters/desktop/provider/providerOwner.ts:270:21)`;

test('only exact handled R17 Native WebKit reload wire aborts become retained diagnostics', () => {
  for (const candidate of [pendingAbort, providerFlushAbort]) {
    const value = { ...observed, stack: candidate };
    assert.equal(isCaughtCorpusNavigationError(value), true);
    assert.equal(isCaughtCorpusNavigationError({ ...value, departingController: 'notes/MarkdownLibraryConnection' }), true);
    const navigationDiagnostics = [`native (reload-native): ${candidate}`];
    assertCompositionBrowserObservations({ forbidden: [], errors: [], unhandled: [], navigationDiagnostics });
    assert.deepEqual(navigationDiagnostics, [`native (reload-native): ${candidate}`]);
    assert.throws(() => assertCompositionBrowserObservations({ forbidden: [], errors: [],
      unhandled: ['composition-unhandled:Error: real operation failure'], navigationDiagnostics }), assert.AssertionError);
    for (const change of [{ engine: 'chromium' as const }, { host: 'web' }, { stage: 'active' }, { stage: 'reload-web' },
      { departingController: undefined }, { departingController: 'other/controller' }])
      assert.equal(isCaughtCorpusNavigationError({ ...value, ...change }), false);
    for (const wrong of [
      candidate.split(origin).join('http://127.0.0.1:49787'),
      candidate.replace('due to access control checks.', 'HTTP 403 Forbidden.'),
      candidate.replace('due to access control checks.', 'invalid-admission'),
      candidate.replace('/src/adapters/desktop/bootstrapHostDriver.ts:', '/src/adapters/desktop/editRepository.ts:'),
      candidate.replace('at wire (', 'at other ('),
      candidate.replace('web-inspector://bootstrap.js:', 'http://other/bootstrap.js:'),
      candidate.replace('/api/edits/pending-records ', '/api/edits/commit ').replace('/api/edits/provider-owner/replication/flush ', '/api/edits/provider-owner/execute '),
    ]) assert.equal(isCaughtCorpusNavigationError({ ...value, stack: wrong }), false, wrong);
  }
  assert.equal(isCaughtCorpusNavigationError({ ...observed, stack: providerFlushAbort.replace('at startPass (', 'at other (') }), false);
  assert.equal(isCaughtCorpusNavigationError({ ...observed, stack: providerFlushAbort.replace('at settled (', 'at other (') }), false);
});


test('only the exact three-line R24 Native WebKit departing read is retained as diagnostic', () => {
  const readAbort = wireAbort('/api/edits/read');
  const value = { ...observed, stack: readAbort };
  assert.equal(isCaughtCorpusNavigationError(value), true);
  assert.equal(isCaughtCorpusNavigationError({ ...value, departingController: 'notes/MarkdownLibraryConnection' }), true);
  assert.equal(isCaughtCorpusNavigationError({ ...value, stack: readAbort.replace(':135:34)', ':9:7)') }), true);
  const navigationDiagnostics = [`native (reload-native): ${readAbort}`];
  assertCompositionBrowserObservations({ forbidden: [], errors: [], unhandled: [], navigationDiagnostics });
  assert.deepEqual(navigationDiagnostics, [`native (reload-native): ${readAbort}`]);
  assert.throws(() => assertCompositionBrowserObservations({ forbidden: [], errors: [],
    unhandled: ['composition-unhandled:Error: actual authority failure'], navigationDiagnostics }), assert.AssertionError);
  for (const change of [{ engine: 'chromium' as const }, { host: 'web' }, { stage: 'active' }, { stage: 'opening' },
    { stage: 'reload-web' }, { departingController: undefined }, { departingController: 'other/controller' }])
    assert.equal(isCaughtCorpusNavigationError({ ...value, ...change }), false);
  for (const wrong of [
    readAbort.split(origin).join('http://127.0.0.1:49787'),
    readAbort.replace('/api/edits/read ', '/api/edits/commit '),
    readAbort.replace('/api/edits/read ', '/api/edits/read-resource '),
    readAbort.replace('due to access control checks.', 'HTTP 401 Unauthorized.'),
    readAbort.replace('due to access control checks.', 'HTTP 403 Forbidden.'),
    readAbort.replace('due to access control checks.', 'invalid-admission'),
    readAbort.replace('    at unknown (web-inspector://bootstrap.js:703:125)\n', ''),
    readAbort.replace('web-inspector://bootstrap.js:', 'http://other/bootstrap.js:'),
    readAbort.replace('at wire (', 'at other ('),
    readAbort.replace('/src/adapters/desktop/bootstrapHostDriver.ts:', '/src/adapters/desktop/editRepository.ts:'),
    readAbort.replace(':135:34)', ':unknown:34)'),
    readAbort + '\n    at commit (http://other/authority.ts:1:1)',
    readAbort + '\n', '\n' + readAbort,
  ]) assert.equal(isCaughtCorpusNavigationError({ ...value, stack: wrong }), false, wrong);
});

// Provisional signature: runtime evidence from fetcher-wire-navigation.mjs is required before adoption.
test('only one exact current fixture fetcher frame may accompany the departing Native WebKit read', () => {
  const original = wireAbort('/api/edits/read');
  const wrapped = original.replace(`    at wire (${origin}`, `    at fetcher (${origin}/e2e/fixtures/documentComposition.tsx:108:23)\n    at wire (${origin}`);
  const value = { ...observed, stack: wrapped };
  assert.equal(isCaughtCorpusNavigationError(value), true);
  assert.equal(isCaughtCorpusNavigationError({ ...value, departingController: 'notes/MarkdownLibraryConnection' }), true);
  const navigationDiagnostics = [`native (reload-native): ${wrapped}`];
  assertCompositionBrowserObservations({ forbidden: [], errors: [], unhandled: [], navigationDiagnostics });
  assert.deepEqual(navigationDiagnostics, [`native (reload-native): ${wrapped}`]);
  assert.throws(() => assertCompositionBrowserObservations({ forbidden: [], errors: [],
    unhandled: ['composition-unhandled:Error: independent operation failure'], navigationDiagnostics }), assert.AssertionError);
  for (const change of [{ engine: 'chromium' as const }, { host: 'web' }, { stage: 'active' }, { stage: 'opening' },
    { stage: 'reload-web' }, { departingController: undefined }, { departingController: 'other/controller' }])
    assert.equal(isCaughtCorpusNavigationError({ ...value, ...change }), false);
  for (const wrong of [
    wrapped.split(origin).join('http://127.0.0.1:49787'),
    wrapped.replace(`at fetcher (${origin}`, 'at fetcher (http://127.0.0.1:49787'),
    wrapped.replace('/api/edits/read ', '/api/edits/commit '),
    wrapped.replace('/api/edits/read ', '/api/edits/read-resource '),
    wrapped.replace('due to access control checks.', 'HTTP 401 Unauthorized.'),
    wrapped.replace('due to access control checks.', 'HTTP 403 Forbidden.'),
    wrapped.replace('due to access control checks.', 'native-request-failed'),
    wrapped.replace('due to access control checks.', 'invalid-admission'),
    wrapped.replace('at fetcher (', 'at request ('),
    wrapped.replace('/e2e/fixtures/documentComposition.tsx:', '/e2e/fixtures/other.tsx:'),
    wrapped.replace(':108:23)', ':unknown:23)'),
    wrapped.replace('web-inspector://bootstrap.js:', 'http://other/bootstrap.js:'),
    wrapped.replace('at wire (', 'at commit ('),
    wrapped.replace('/src/adapters/desktop/bootstrapHostDriver.ts:', '/src/adapters/desktop/provider/providerOwner.ts:'),
    wrapped.replace(':135:34)', ':unknown:34)'),
    wrapped + '\n    at authority (http://other/authority.ts:1:1)',
    wrapped.replace('\n    at wire', `\n    at operation (${origin}/src/adapters/desktop/provider/providerOwner.ts:1:1)\n    at wire`),
    wrapped + '\n', '\n' + wrapped,
  ]) assert.equal(isCaughtCorpusNavigationError({ ...value, stack: wrong }), false, wrong);
});
