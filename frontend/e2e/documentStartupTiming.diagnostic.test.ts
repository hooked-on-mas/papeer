import assert from 'node:assert/strict';
import test from 'node:test';
import { openComposition } from './support/documentComposition.ts';

// Work B10 observation only; this filename is intentionally outside the release browser-suite discovery pattern (like documentStartup.diagnostic.test.ts).
// One cold Native+Web composition start (new sidecar, Vite cache, browser) per process, with the same heading and readiness assertions as the acceptance
// fixture. The engine comes from PAPEER_STARTUP_ENGINE; the caller serialises runs behind a memory gate and sets PAPEER_COMPOSITION_STARTUP_TIMING=1.
const engine = process.env.PAPEER_STARTUP_ENGINE;
assert.ok(engine === 'webkit' || engine === 'chromium', 'PAPEER_STARTUP_ENGINE must be webkit or chromium');
test(`cold ${engine} document initialization timing`, { timeout: 360_000 }, async t => {
  const { finish } = await openComposition(t, engine);
  await finish();
});
