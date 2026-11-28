import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { googleDrivePrincipalDigest } from '../../../src/runtime/edits/provider/providerPrincipal.ts';
test('Google permission principal digest uses shared domain bytes without mutating canonical UUID scope', async () => {
 const vectors = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, '../../../../tests/fixtures/provider/principal-vectors.json'), 'utf8'));
 for (const row of vectors.valid) assert.equal(await googleDrivePrincipalDigest(row.permissionId), row.sha256);
 for (const value of vectors.invalid) await assert.rejects(googleDrivePrincipalDigest(value), /drive-principal-invalid/);
 assert.notEqual(await googleDrivePrincipalDigest('permission-A'), await googleDrivePrincipalDigest('permission-B'));
});
