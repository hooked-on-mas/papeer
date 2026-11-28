import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateLegacyMigrationHold } from '../src/runtime/edits/contracts.ts';

test('startup admission uses the Python corpus without UUID/newline, boolean-version or auto-release coercion', () => {
  const corpus = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8')).legacyMigrationHolds;
  for (const value of corpus) {
    if (value.valid) assert.doesNotThrow(() => validateLegacyMigrationHold(value.value));
    else assert.throws(() => validateLegacyMigrationHold(value.value));
  }
});
