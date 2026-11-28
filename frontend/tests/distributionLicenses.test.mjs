import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { distributionLicenses } from '../buildLicenses.ts';

test('distribution emits bundled PDF dependency and font license texts', () => {
  const plugin = distributionLicenses(), assets = new Map();
  const generate = plugin.generateBundle;
  assert.equal(typeof generate, 'function');
  generate.call({ getModuleIds: () => [], emitFile: ({fileName,source}) => assets.set(fileName,source) });
  for (const name of ['pdf-lib-MIT.txt','pdf-lib-fontkit-MIT.txt','pdf-lib-standard-fonts-MIT.txt','pdf-lib-upng-MIT.txt','pako-LICENSE.txt','tslib-1-LICENSE.txt','tslib-1-CopyrightNotice.txt']) {
    assert.equal(assets.get(`third-party/${name}`), readFileSync(new URL(`../distribution-licenses/${name}`,import.meta.url),'utf8'));
  }
  assert.ok(assets.get('noto-sans-jp-OFL.txt')?.includes('SIL OPEN FONT LICENSE'));
  assert.ok(assets.get('noto-serif-jp-OFL.txt')?.includes('SIL OPEN FONT LICENSE'));
  assert.ok(assets.get('source-han-sans-OFL.txt')?.includes('SIL OPEN FONT LICENSE'));
  assert.ok(assets.get('source-han-serif-OFL.txt')?.includes('SIL OPEN FONT LICENSE'));
});
