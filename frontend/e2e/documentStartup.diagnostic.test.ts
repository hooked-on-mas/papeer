import test from 'node:test';
import { openComposition } from './support/documentComposition.ts';

// Focused diagnosis only; this filename is intentionally outside the release
// browser-suite discovery pattern. Every iteration uses a new real repository,
// browser, Vite cache and ordinary publication/transport, with the same heading
// and readiness assertions as the acceptance fixture.
test('cold WebKit document initialization diagnostic', { timeout: 360_000 }, async t => {
  for (let iteration = 0; iteration < 6; iteration++) {
    let failed = false;
    await t.test(`cold initialization ${iteration + 1}`, async subtest => {
      try {
        const { finish } = await openComposition(subtest, 'webkit');
        await finish();
      } catch (error) { failed = true; throw error; }
    });
    if (failed) break;
  }
});
