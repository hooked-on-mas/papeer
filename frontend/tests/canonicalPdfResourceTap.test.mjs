import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectedTapPassed } from '../scripts/canonical-pdf-resource-tap.mjs';
const name = 'canonical PDF resource/Document lifetime and real Reader history (chromium)';
const good = `TAP version 13\n# Subtest: ${name}\nok 1 - ${name}\n  ---\n  duration_ms: 18\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 20\n`;
test('Node 24 one-selected TAP is accepted', () => assert.equal(selectedTapPassed(good, name), true));
for (const [description, fixture] of [
  ['selected skip', good.replace(`ok 1 - ${name}`, `ok 1 - ${name} # SKIP`) .replace('# pass 1', '# pass 0').replace('# skipped 0', '# skipped 1')],
  ['different name', good.replace(`ok 1 - ${name}`, 'ok 1 - another test')],
  ['not selected', good.replace(`ok 1 - ${name}\n`, '').replace('1..1', '1..0').replace('# tests 1', '# tests 0').replace('# pass 1', '# pass 0')],
  ['selected failure', good.replace(`ok 1 - ${name}`, `not ok 1 - ${name}`).replace('# pass 1', '# pass 0').replace('# fail 0', '# fail 1')],
  ['unexpected test', good.replace('1..1', 'ok 2 - another test\n1..2').replace('# tests 1', '# tests 2')],
  ['bad plan', good.replace('1..1', '1..0')],
  ['cancelled', good.replace('# cancelled 0', '# cancelled 1')],
  ['todo', good.replace('# todo 0', '# todo 1')],
  ['duplicate summary', good.replace('# pass 1', '# pass 1\n# pass 1')],
  ['truncated', good.replace('# tests 1\n', '')],
]) test(`reject ${description}`, () => assert.equal(selectedTapPassed(fixture, name), false));
