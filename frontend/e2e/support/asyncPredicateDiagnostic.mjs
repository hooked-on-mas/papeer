/** App-free diagnostic for the installed Playwright waitForFunction implementation.
 * Run: node e2e/support/asyncPredicateDiagnostic.mjs
 * This is deliberately outside browser suite discovery and imports no application code.
 */
import assert from 'node:assert/strict';
import { webkit } from 'playwright-core';

const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<title>Async predicate diagnostic</title>');
  const handle = await page.waitForFunction(async () => false, undefined, { timeout: 1000 });
  const result = await handle.jsonValue();
  assert.equal(result, false);
  console.log(JSON.stringify({ asyncPredicateResolvedWithoutTruth: true, result }));
  await handle.dispose();
  let attempts = 0;
  for (;;) {
    const value = await page.evaluate(attempt => Promise.resolve(attempt >= 3), ++attempts);
    if (value) break;
    assert.ok(attempts < 5);
    await page.waitForTimeout(10);
  }
  assert.equal(attempts, 3);
  console.log(JSON.stringify({ awaitedNodePollingAttempts: attempts, acceptedOnlyTrue: true }));
} finally {
  await browser.close();
  console.log('browser closed');
}
