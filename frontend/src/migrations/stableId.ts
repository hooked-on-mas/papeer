import { editSchema } from '../runtime/edits/contracts.ts';
import { editContentHash } from '../runtime/edits/editContentHash.ts';
import { validateStructure } from '../runtime/edits/schemaValidator.ts';
import { EditRejected } from '../runtime/edits/editModel.ts';

/** One-way migration identities are independent of run ID/target epoch and never depend on row order.
 * The complete key is hashed with the versioned content codec, then encoded in a UUID-shaped ID.
 */
export async function migrationStableId(libraryId: string, kind: string, source: readonly string[]): Promise<string> {
  validateStructure(editSchema, 'Id', libraryId);
  if (typeof kind !== 'string' || !kind || Array.from(kind).length > 1000 || !Array.isArray(source) || !source.length
    || source.some(value => typeof value !== 'string' || !value || Array.from(value).length > 1000)) throw new EditRejected('migration-id-source');
  const hash = await editContentHash(['paper-desk-migration-v1', libraryId, kind, [...source]]);
  const chars = hash.slice(0, 32).split(''); chars[12] = '8'; chars[16] = '89ab'[parseInt(chars[16], 16) & 3];
  const hex = chars.join(''); return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
