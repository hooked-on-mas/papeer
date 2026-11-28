/**
 * Work B13-d U1: schemaValidator.ts no longer decides every oneOf branch by throwing an Error. These tests prove the change is a pure speed-up:
 *   - the reference (pre-U1 source, byte-checked) and the product give the same result for every input tried: "ok" or the full exception text;
 *   - the structural premises the speed-up relies on are asserted against the real schema (a schema that breaks them still validates correctly,
 *     because the product then simply keeps the old try/catch path; these tests only say that the fast path no longer applies);
 *   - the differential itself has teeth: deliberately broken copies of the product are caught.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { editSchema } from '../src/runtime/edits/contracts.ts';
import { validateStructure } from '../src/runtime/edits/schemaValidator.ts';
import { validateStructureLegacy } from './support/schemaValidatorLegacy.ts';
import { compareOne, finish, makeRng, newReport, outcome, runDefinitionDifferential, runSubtreeDifferential, runSyntheticDifferential, sampleValid,
  type Loose, type Report, type Validate } from './support/schemaDifferential.ts';

const SEED = 20261118;
const lines = (report: Report): string => `${report.cases} cases (${report.accepted} accepted, ${report.rejected} rejected, ${report.distinctOutcomes} distinct outcomes, ${report.mismatchCount} mismatches)`;
const root = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const schema: Loose = editSchema;
const defs: Record<string, Loose> = schema.$defs;
const resolveRef = (rule: Loose, seen = new Set<string>()): Loose => {
  let current = rule;
  while (current.$ref) {
    const key = current.$ref.split('/').pop()!;
    assert.ok(Object.prototype.hasOwnProperty.call(defs, key), `unresolved $ref ${current.$ref}`);
    assert.ok(!seen.has(key), `cyclic $ref ${current.$ref}`);
    seen.add(key);
    current = defs[key];
  }
  return current;
};
const refChain = (rule: Loose): number => { let length = 0; let current = rule; while (current.$ref) { length++; current = defs[current.$ref.split('/').pop()!]; if (length > 100) return length; } return length; };
/** Keep in step with MAX_REF_HOPS in schemaValidator.ts. */
const MAX_REF_HOPS = 8;

// ------------------------------------------------------------------------------------------------------------------ the reference copy
test('the reference implementation is a byte-for-byte copy of the pre-U1 validator (only the function name differs)', () => {
  const text = read('frontend/tests/support/schemaValidatorLegacy.ts').replace(/\r\n/g, '\n');
  const marker = '//--- legacy body begins on the next line ---\n';
  assert.ok(text.includes(marker));
  const body = text.slice(text.indexOf(marker) + marker.length).replace('export function validateStructureLegacy(', 'export function validateStructure(');
  assert.equal(createHash('sha256').update(body, 'utf8').digest('hex'), '94ad92d6f271f967810c5bf70f527a8ad9702e579c4124f8acff249c8a773b9d');
});

// ------------------------------------------------------------------------------------------------------------------ structural premises
test('static premises: the real schema satisfies what the oneOf fast path assumes (a failure means the fast path no longer fully applies, not that validation is wrong)', () => {
  const file = JSON.parse(read('schema/edit-contracts.json')) as Loose;
  assert.deepEqual(file, schema, 'the generated contracts.ts embeds exactly schema/edit-contracts.json');
  let oneOfs = 0, branches = 0, kindBranches = 0, otherBranches = 0;
  const problems: string[] = [];
  const visitRule = (rule: Loose, where: string): void => {
    if (rule.oneOf) {
      oneOfs++;
      const keys = Object.keys(rule);
      if (keys.length !== 1) problems.push(`${where}: oneOf combined with ${keys.filter(key => key !== 'oneOf').join(',')}`);
      for (const branch of rule.oneOf as Loose[]) {
        branches++;
        if (branch.$ref && Object.keys(branch).length !== 1) problems.push(`${where}: a $ref branch has sibling keywords`);
        if (refChain(branch) > MAX_REF_HOPS) problems.push(`${where}: $ref chain longer than ${MAX_REF_HOPS}`);
        const resolved = resolveRef(branch);
        if (resolved.oneOf) problems.push(`${where}: nested oneOf`);
        if (resolved.type && resolved.oneOf) problems.push(`${where}: branch with oneOf and type`);
        if (resolved.type === 'object' && resolved.properties && Object.prototype.hasOwnProperty.call(resolved.properties, 'kind')) {
          const kind = resolveRef(resolved.properties.kind);
          if ('const' in kind) {
            kindBranches++;
            if (!(resolved.required ?? []).includes('kind')) problems.push(`${where}: a const kind branch where kind is not required`);
            if (typeof kind.const !== 'string') problems.push(`${where}: a non-string const kind`);
          } else problems.push(`${where}: a kind property without const`);
        } else otherBranches++;
        visitRule(branch, `${where}|`);
      }
    }
    for (const [key, property] of Object.entries<Loose>(rule.properties ?? {})) visitRule(property, `${where}.${key}`);
    if (rule.items) visitRule(rule.items, `${where}[]`);
    if (rule.additionalProperties && typeof rule.additionalProperties === 'object') visitRule(rule.additionalProperties, `${where}{}`);
  };
  for (const [name, rule] of Object.entries(defs)) {
    if (rule.$ref) { assert.ok(!refChain(rule) || refChain(rule) <= MAX_REF_HOPS, `${name}: long $ref chain`); resolveRef(rule); }
    visitRule(rule, name);
  }
  // Every $ref in the whole document resolves (no cycle, within the hop limit).
  let refs = 0;
  const walkRefs = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walkRefs);
    else if (node && typeof node === 'object') {
      const object = node as Loose;
      if (typeof object.$ref === 'string') { refs++; resolveRef(object); assert.ok(refChain(object) <= MAX_REF_HOPS, `$ref chain too long: ${object.$ref}`); }
      Object.values(object).forEach(walkRefs);
    }
  };
  walkRefs(defs);
  assert.deepEqual(problems, []);
  assert.ok(oneOfs > 0 && branches > 0 && kindBranches > 0 && refs > 0, 'the analysis must not be vacuous');
  // Informational: the shape of the schema this was written against (not asserted exactly, so that adding a type does not break the test).
  console.log(`# schema: ${Object.keys(defs).length} defs, ${oneOfs} oneOf, ${branches} branches (${kindBranches} const-kind objects, ${otherBranches} others), ${refs} $refs`);
});

// ------------------------------------------------------------------------------------------------------------------ boundary inputs
type Case = { label: string; schema: Loose; name: string; values: unknown[] };
const make = (label: string, definitions: Record<string, Loose>, name: string, values: unknown[]): Case => ({ label, schema: { $defs: definitions }, name, values });
const longChain = (length: number, last: Loose): Record<string, Loose> => {
  const definitions: Record<string, Loose> = { Last: last };
  for (let index = length - 1; index >= 0; index--) definitions[`L${index}`] = { $ref: `#/$defs/${index === length - 1 ? 'Last' : `L${index + 1}`}` };
  return definitions;
};
const nonEnumerableKind = (kind: string): unknown => Object.defineProperty({ v: 'x' }, 'kind', { value: kind, enumerable: false });
const accessorKind = (kind: string): unknown => Object.defineProperty({ v: 'x' }, 'kind', { get: () => kind, enumerable: true });
const nullProto = (value: Record<string, unknown>): unknown => Object.assign(Object.create(null), value);
class Klass { kind = 'a'; v = 'x'; }

function boundaryCases(): Case[] {
  const objectA = { type: 'object', properties: { kind: { const: 'a' }, v: { type: 'string' } }, required: ['kind', 'v'], additionalProperties: false };
  const objectB = { type: 'object', properties: { kind: { const: 'b' }, v: { type: 'number' } }, required: ['kind', 'v'], additionalProperties: false };
  const cases: Case[] = [
    make('zero / one / two matches', {
      Two: { oneOf: [{ type: 'string' }, { type: 'string', minLength: 0 }] }, Zero: { oneOf: [{ type: 'null' }, { type: 'boolean' }] },
      One: { oneOf: [{ type: 'string' }, { type: 'number' }] }, Empty: { oneOf: [] },
    }, '', []),
    make('const null and other falsy constants', {
      Null: { oneOf: [{ const: null }, { type: 'string' }] }, Falsy: { oneOf: [{ const: 0 }, { const: false }, { const: '' }, { const: null }] },
      Nan: { oneOf: [{ const: NaN }, { type: 'number' }] }, Undef: { oneOf: [{ const: undefined }, { type: 'null' }] },
    }, '', []),
    make('enum containing null, NaN and falsy values', {
      Enum: { oneOf: [{ enum: ['a', null] }, { type: 'number' }] }, Nan: { oneOf: [{ enum: [NaN] }, { enum: [0] }] },
      Falsy: { oneOf: [{ enum: [0, '', false] }, { type: 'null' }] }, NotArray: { oneOf: [{ enum: 'abc' }, { type: 'null' }] },
    }, '', []),
    make('integer versus number', {
      Both: { oneOf: [{ type: 'integer' }, { type: 'number' }] }, Bounded: { oneOf: [{ type: 'integer', minimum: 2 }, { type: 'number', exclusiveMinimum: 5 }] },
      OnlyNumber: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    }, '', []),
    make('object branches discriminated by a required const kind', {
      Union: { oneOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }] }, A: objectA, B: objectB,
      Mixed: { oneOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }, { type: 'object', properties: { kind: { const: 'opt' } }, additionalProperties: false }] },
      OptionalKind: { oneOf: [{ type: 'object', properties: { kind: { const: 'a' } }, required: [], additionalProperties: false }, { type: 'string' }] },
      OptionalKindNoRequired: { oneOf: [{ type: 'object', properties: { kind: { const: 'a' } }, additionalProperties: false }, { type: 'null' }] },
      ViaRef: { oneOf: [{ type: 'object', properties: { kind: { $ref: '#/$defs/KindA' }, v: { type: 'string' } }, required: ['kind'] }, { type: 'null' }] }, KindA: { const: 'a' },
      KindEnum: { oneOf: [{ type: 'object', properties: { kind: { enum: ['a', 'b'] } }, required: ['kind'] }, { type: 'null' }] },
      KindNotListed: { oneOf: [{ type: 'object', properties: { v: { type: 'string' } }, required: ['kind'] }, { type: 'null' }] },
      KindNumber: { oneOf: [{ type: 'object', properties: { kind: { const: 1 } }, required: ['kind'] }, { type: 'object', properties: { kind: { const: null } }, required: ['kind'] }] },
      KindAndAdditional: { oneOf: [{ type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'], additionalProperties: { type: 'string' } }, { type: 'null' }] },
    }, '', []),
    make('unresolvable, cyclic and self-referencing $ref', {
      Missing: { oneOf: [{ $ref: '#/$defs/Nope' }, { const: 'x' }] }, Cyclic: { oneOf: [{ $ref: '#/$defs/C1' }, { const: 'x' }] },
      C1: { $ref: '#/$defs/C2' }, C2: { $ref: '#/$defs/C1' }, SelfRef: { oneOf: [{ $ref: '#/$defs/Self' }, { const: 'x' }] }, Self: { $ref: '#/$defs/Self' },
      TopCyclic: { $ref: '#/$defs/C1' }, TopMissing: { $ref: '#/$defs/Nope' },
      Inherited: { oneOf: [{ $ref: '#/$defs/constructor' }, { $ref: '#/$defs/__proto__' }, { $ref: '#/$defs/toString' }, { $ref: '#/$defs/' }, { const: 'x' }] },
      NotString: { oneOf: [{ $ref: 5 }, { const: 'x' }] }, EmptyRef: { oneOf: [{ $ref: '' }, { const: 'x' }] },
      KindCyclic: { oneOf: [{ type: 'object', properties: { kind: { $ref: '#/$defs/C1' } }, required: ['kind'] }, { type: 'null' }] },
    }, '', []),
    make('mixed keywords: oneOf with type, nested oneOf, $ref with siblings', {
      OneOfAndType: { oneOf: [{ const: 'a' }, { const: 'b' }], type: 'number' },
      Nested: { oneOf: [{ type: 'string', oneOf: [{ const: 'a' }] }, { type: 'null' }] },
      NestedNull: { oneOf: [{ type: 'null', oneOf: [{ const: 'a' }] }, { const: 'b' }] },
      NestedObject: { oneOf: [{ type: 'object', oneOf: [{ type: 'string' }] }, { type: 'null' }] },
      RefSiblings: { oneOf: [{ $ref: '#/$defs/KindA', const: 'z' }, { $ref: '#/$defs/KindA', type: 'number' }] }, KindA: { const: 'a' },
      DoubleNested: { oneOf: [{ oneOf: [{ oneOf: [{ const: 1 }] }] }, { const: 2 }] },
    }, '', []),
    make('other types and malformed rules', {
      Arrays: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] }, Strings: { oneOf: [{ type: 'string', pattern: '^a+$' }, { type: 'string', maxLength: 2 }] },
      Unknown: { oneOf: [{ type: 'weird' }, { type: 'null' }] }, NoKeywords: { oneOf: [{}, { type: 'null' }] }, Holes: { oneOf: [null, { const: 1 }] },
      BadPattern: { oneOf: [{ type: 'string', pattern: '(' }, { type: 'null' }] }, Booleans: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
      ArrayNoItems: { oneOf: [{ type: 'array' }, { type: 'null' }] },
    }, '', []),
  ];
  // Fill in names and values per group.
  const values: Record<string, unknown[]> = {
    Two: ['a', '', 1, null], Zero: [null, true, 0, undefined], One: ['a', '', 1, NaN, null], Empty: ['a'],
    Null: [null, 'a', 0, undefined, false], Falsy: [0, -0, false, '', null, undefined, NaN], Nan: [NaN, 0, 1, Infinity, 'a', null], Undef: [undefined, null, 0],
    Enum: [null, 'a', 'b', 1, NaN, undefined, 0], Falsy2: [0, '', false, null, -0], NotArray: ['a', 'b', 'abc', null, 1],
    Both: [1, 1.5, 2 ** 53, -(2 ** 53 - 1), NaN, Infinity, '1', -0, 1e21, 0, 5e-324], Bounded: [1, 2, 3, 5.5, 6, 6.5, NaN, 2 ** 53], OnlyNumber: [1, NaN, Infinity, null, '1', 1.5],
    Union: [{ kind: 'a', v: 'x' }, { kind: 'b', v: 1 }, { kind: 'b', v: 'x' }, {}, { kind: 'c' }, null, [], { v: 'x' }, nonEnumerableKind('a'), nonEnumerableKind('b'), accessorKind('a'),
      accessorKind('b'), nullProto({ kind: 'a', v: 'x' }), nullProto({ kind: 'b', v: 1 }), new Klass(), new Proxy({ kind: 'a', v: 'x' }, {}),
      new Proxy({ kind: 'a', v: 'x' }, { getOwnPropertyDescriptor: () => { throw new TypeError('trap'); } }), new Proxy({ kind: 'b', v: 1 }, { getPrototypeOf: () => { throw new TypeError('trap'); } }),
      Object.create({ kind: 'a', v: 'x' }), Object.defineProperty({ v: 'x' }, 'kind', { get: () => { throw new RangeError('getter'); }, enumerable: true }),
      Object.defineProperty({ kind: 'a', v: 'x' }, Symbol('s'), { value: 1, enumerable: true }), { kind: 'a', v: 'x', extra: 1 }, { kind: 'a' }, { kind: undefined, v: 'x' }],
    Mixed: [{ kind: 'opt' }, { kind: 'a', v: 'x' }, { kind: 'b', v: 1 }, {}, { kind: 'opt', v: 1 }, nonEnumerableKind('opt'), accessorKind('opt')],
    OptionalKind: [{}, { kind: 'a' }, { kind: 'b' }, 'x', nonEnumerableKind('b'), nonEnumerableKind('a'), accessorKind('a'), nullProto({}), null, { v: 1 }],
    OptionalKindNoRequired: [{}, { kind: 'a' }, { kind: 'b' }, null, nonEnumerableKind('b')],
    ViaRef: [{ kind: 'a' }, { kind: 'a', v: 'x' }, { kind: 'b' }, { v: 'x' }, null, nonEnumerableKind('a'), nonEnumerableKind('z'), accessorKind('z')],
    KindEnum: [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }, {}, null],
    KindNotListed: [{ v: 'x' }, { kind: 'x', v: 'x' }, {}, null, { kind: 1 }],
    KindNumber: [{ kind: 1 }, { kind: null }, { kind: '1' }, { kind: 0 }, {}, { kind: undefined }],
    KindAndAdditional: [{ kind: 'a' }, { kind: 'a', other: 'x' }, { kind: 'a', other: 1 }, { kind: 'b' }, null],
    Missing: ['x', 'y', null], Cyclic: ['x', 'y', null], SelfRef: ['x', 'y'], TopCyclic: ['x', null], TopMissing: ['x'], Inherited: ['x', 'y', 1, null], NotString: ['x', 'y'], EmptyRef: ['x', 'y'],
    KindCyclic: [{ kind: 'a' }, null, {}],
    OneOfAndType: ['a', 'b', 'c', 1, null], Nested: ['a', 'b', null, 1], NestedNull: ['a', 'b', null], NestedObject: ['a', {}, null], RefSiblings: ['a', 'z', 1, 'b'], DoubleNested: [1, 2, 3],
    Arrays: [['a'], 'a', [1], {}, [], [, 'a'], [undefined], [[]]], Strings: ['a', 'aaa', 'bbb', 'b', '\ud800', '', 'aa'], Unknown: [null, 'a'], NoKeywords: [null, 1, {}], Holes: [1, 2],
    BadPattern: ['a', null], Booleans: [true, false, null, 0], ArrayNoItems: [[], [1], null],
  };
  const grouped: Case[] = [];
  for (const entry of cases) for (const name of Object.keys(entry.schema.$defs)) {
    const key = name === 'Falsy' && entry.label.startsWith('enum') ? 'Falsy2' : name;
    if (values[key]) grouped.push({ label: `${entry.label} / ${name}`, schema: entry.schema, name, values: values[key] });
  }
  // $ref chains right below and above the hop limit, ending in a const (a long chain must still be followed by the old path, not mistaken for a mismatch).
  for (const length of [1, 2, MAX_REF_HOPS - 1, MAX_REF_HOPS, MAX_REF_HOPS + 1, MAX_REF_HOPS + 2, 40]) {
    const definitions: Record<string, Loose> = { ...longChain(length, { const: 'x' }), Top: { oneOf: [{ $ref: '#/$defs/L0' }, { type: 'null' }] } };
    grouped.push({ label: `ref chain of ${length} to a const`, schema: { $defs: definitions }, name: 'Top', values: ['x', 'y', null, 1] });
    const kindDefinitions: Record<string, Loose> = { ...longChain(length, { const: 'a' }),
      Top: { oneOf: [{ type: 'object', properties: { kind: { $ref: '#/$defs/L0' } }, required: ['kind'] }, { type: 'null' }] } };
    grouped.push({ label: `ref chain of ${length} to a const kind`, schema: { $defs: kindDefinitions }, name: 'Top', values: [{ kind: 'a' }, { kind: 'b' }, {}, null, nonEnumerableKind('b')] });
    const branchDefinitions: Record<string, Loose> = { ...longChain(length, { type: 'string' }), Top: { oneOf: [{ $ref: '#/$defs/L0' }, { $ref: '#/$defs/L0' }] } };
    grouped.push({ label: `ref chain of ${length}, two matching branches`, schema: { $defs: branchDefinitions }, name: 'Top', values: ['a', 1] });
  }
  return grouped;
}

function runBoundary(reference: Validate, candidate: Validate): Report {
  const report = newReport();
  for (const entry of boundaryCases()) for (const value of entry.values) compareOne(report, reference, candidate, entry.schema, entry.name, value);
  return finish(report);
}

test('boundary inputs: 0 / 1 / 2 matches, const null, enum with null, integer vs number, optional kind, odd objects, $ref chains (no hang)', { timeout: 60_000 }, () => {
  const report = runBoundary(validateStructureLegacy, validateStructure);
  console.log(`# boundary differential: ${boundaryCases().length} (schema, definition) groups, ${lines(report)}`);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.mismatchCount, 0);
  assert.ok(report.cases > 300 && report.accepted > 40 && report.rejected > 100, JSON.stringify(report));
  const run = (_label: string, definitions: Record<string, Loose>, value: unknown, entry = 'Top') => outcome(validateStructure, { $defs: definitions }, entry, value);
  // Explicit expectations (so a flaw shared by both implementations cannot hide behind equality).
  const invalid = (path: string) => `Error: Invalid edit data: ${path}`;
  assert.equal(run('two', { Top: { oneOf: [{ type: 'string' }, { type: 'string', minLength: 0 }] } }, 'a'), invalid('Top'), 'two matches fail');
  assert.equal(run('zero', { Top: { oneOf: [{ type: 'null' }, { type: 'boolean' }] } }, 1), invalid('Top'), 'zero matches fail');
  assert.equal(run('one', { Top: { oneOf: [{ type: 'string' }, { type: 'number' }] } }, 1), 'ok');
  assert.equal(run('const null', { Top: { oneOf: [{ const: null }, { type: 'string' }] } }, null), 'ok');
  assert.equal(run('enum null', { Top: { oneOf: [{ enum: ['a', null] }, { type: 'number' }] } }, null), 'ok');
  assert.equal(run('integer both', { Top: { oneOf: [{ type: 'integer' }, { type: 'number' }] } }, 1), invalid('Top'), '1 is both an integer and a number');
  assert.equal(run('number only', { Top: { oneOf: [{ type: 'integer' }, { type: 'number' }] } }, 1.5), 'ok');
  assert.equal(run('optional kind', { Top: { oneOf: [{ type: 'object', properties: { kind: { const: 'a' } }, additionalProperties: false }, { type: 'null' }] } }, {}), 'ok', 'an absent optional kind still matches');
  assert.equal(run('non-enumerable kind', { Top: { oneOf: [{ type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'], additionalProperties: false }, { type: 'null' }] } },
    Object.defineProperty({}, 'kind', { value: 'b', enumerable: false })), 'ok', 'visit never looks at a non-enumerable key, so the branch matches');
  assert.equal(run('long chain', longChain(MAX_REF_HOPS + 3, { const: 'x' }), 'x', 'L0'), 'ok');
  assert.equal(run('long chain in oneOf', { ...longChain(MAX_REF_HOPS + 3, { const: 'x' }), Top: { oneOf: [{ $ref: '#/$defs/L0' }, { type: 'null' }] } }, 'x'), 'ok');
  assert.equal(run('cyclic in oneOf', { C1: { $ref: '#/$defs/C2' }, C2: { $ref: '#/$defs/C1' }, Top: { oneOf: [{ $ref: '#/$defs/C1' }, { const: 'x' }] } }, 'x'), 'ok', 'a cycle terminates (stack overflow is swallowed like before) and the other branch still matches');
  assert.equal(run('cyclic in oneOf', { C1: { $ref: '#/$defs/C2' }, C2: { $ref: '#/$defs/C1' }, Top: { oneOf: [{ $ref: '#/$defs/C1' }, { const: 'x' }] } }, 'y'), invalid('Top'));
  assert.equal(run('unresolvable', { Top: { oneOf: [{ $ref: '#/$defs/Nope' }, { const: 'x' }] } }, 'x'), 'ok');
});

// ------------------------------------------------------------------------------------------------------------------ differential tests
function fixtureDocuments(): unknown[] {
  const names = ['shared-edits.json', 'canonical-bootstrap.json', 'canonical-local-owner-grant.json', 'shared-legacy-drive.json', 'shared-migration-ids.json',
    'synthetic-provider-owner-plan.json', 'provider-descriptor-bytes.json', 'provider/principal-vectors.json'];
  return names.map(name => JSON.parse(read(`tests/fixtures/${name}`)) as unknown);
}

test('differential: every sub-value of every existing fixture against every definition (old vs new)', { timeout: 300_000 }, () => {
  const report = runSubtreeDifferential(validateStructureLegacy, validateStructure, schema, fixtureDocuments());
  console.log(`# fixture subtree differential: ${lines(report)}`);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.mismatchCount, 0);
  assert.ok(report.cases > 500_000 && report.accepted > 2_000, JSON.stringify(report));
});

test(`differential: every definition x valid values and ~85,000 broken variants (seed ${SEED}), old vs new`, { timeout: 300_000 }, () => {
  const report = runDefinitionDifferential(validateStructureLegacy, validateStructure, schema, SEED, 750);
  console.log(`# definition differential seed ${SEED}: ${lines(report)}`);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.mismatchCount, 0);
  assert.ok(report.cases > 80_000 && report.accepted > 2_000 && report.rejected > 50_000 && report.distinctOutcomes > 100, JSON.stringify(report));
});

test(`differential: random synthetic schemas (every keyword, mixed oneOf, optional kind, unresolvable $ref; seed ${SEED + 1}), old vs new`, { timeout: 300_000 }, () => {
  const report = runSyntheticDifferential(validateStructureLegacy, validateStructure, SEED + 1, 4_000, 8);
  console.log(`# synthetic-schema differential seed ${SEED + 1}: ${lines(report)}`);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.mismatchCount, 0);
  assert.ok(report.cases > 100_000 && report.accepted > 5_000 && report.rejected > 20_000, JSON.stringify(report));
});

test('generated valid values are accepted by the reference for every definition (the differential is not only feeding it rubbish)', () => {
  const rng = makeRng(SEED);
  for (const name of Object.keys(defs)) {
    let accepted = 0;
    for (let i = 0; i < 40; i++) if (outcome(validateStructureLegacy, schema, name, sampleValid(schema, { $ref: `#/$defs/${name}` }, rng)) === 'ok') accepted++;
    assert.equal(accepted, 40, `definition ${name}: only ${accepted}/40 generated values were valid`);
  }
});

// ------------------------------------------------------------------------------------------------------------------ the fast path is really used
function countErrors(action: () => void): number {
  const Original = globalThis.Error;
  let count = 0;
  class Counting extends Original { constructor(message?: string) { super(message); count++; } }
  globalThis.Error = Counting as unknown as ErrorConstructor;
  try { action(); } finally { globalThis.Error = Original; }
  return count;
}

test('the fast path removes the exceptions: valid snapshots validate without constructing any Error (old: one per skipped branch)', () => {
  const fixture = JSON.parse(read('tests/fixtures/shared-edits.json')) as { document: unknown; markdown: unknown; library: unknown; batches: unknown[] };
  for (const [name, value] of [['Snapshot', fixture.document], ['Snapshot', fixture.markdown], ['Snapshot', fixture.library]] as const) {
    const before = countErrors(() => validateStructureLegacy(schema, name, value));
    const after = countErrors(() => validateStructure(schema, name, value));
    assert.ok(before > 0, 'the old validator threw for skipped branches');
    assert.equal(after, 0, 'the new validator does not construct an Error for a valid snapshot');
  }
  let before = 0, after = 0;
  for (const batch of fixture.batches) {
    before += countErrors(() => validateStructureLegacy(schema, 'EditBatch', batch));
    after += countErrors(() => validateStructure(schema, 'EditBatch', batch));
  }
  assert.ok(after < before, `${after} < ${before}`);
  console.log(`# Errors constructed for the fixture batches: ${before} (old) -> ${after} (new)`);
});

// ------------------------------------------------------------------------------------------------------------------ the differential has teeth
const MUTANTS: { name: string; from: string; to: string }[] = [
  { name: 'kind comparison inverted', from: 'own.value !== kind.const', to: 'own.value === kind.const' },
  { name: 'required is not consulted (an optional kind may be skipped)', from: "!Array.isArray(rule.required) || !rule.required.includes('kind') || ", to: '' },
  { name: 'two matches counted as one', from: 'try { visit(branch, data, path); matches++; }', to: 'try { visit(branch, data, path); matches = 1; }' },
  { name: 'const comparison inverted', from: "if ('const' in rule) return data !== rule.const;", to: "if ('const' in rule) return data === rule.const;" },
  { name: 'enum drops falsy members (null in enum)', from: 'Array.isArray(rule.enum) && !rule.enum.includes(data)', to: 'Array.isArray(rule.enum) && !rule.enum.filter(Boolean).includes(data)' },
  { name: 'number rejects non-integers (integer vs number)', from: "case 'integer': case 'number': return typeof data !== 'number';", to: "case 'integer': case 'number': return typeof data !== 'number' || !Number.isInteger(data);" },
  { name: 'non-enumerable kind is treated as present', from: 'own.enumerable === true && ', to: '' },
  { name: 'accessor kind is read as undefined', from: "'value' in own && ", to: '' },
  { name: 'empty string is rejected for a string branch', from: "case 'string': return typeof data !== 'string';", to: "case 'string': return typeof data !== 'string' || data.length === 0;" },
  { name: 'exceptions while deciding are not swallowed', from: '} catch { return false; }', to: '} catch (error) { throw error; }' },
  { name: 'a nested oneOf is classified by its type', from: 'if (rule.oneOf) return false;', to: '' },
  { name: 'false is rejected for a boolean branch', from: "case 'boolean': return typeof data !== 'boolean';", to: "case 'boolean': return typeof data !== 'boolean' || data === false;" },
  { name: 'an empty array is rejected for an array branch', from: "case 'array': return !Array.isArray(data);", to: "case 'array': return !Array.isArray(data) || data.length === 0;" },
  { name: 'a skipped branch is counted as a match', from: 'if (certainlyRejects(branch, data)) continue;', to: 'if (certainlyRejects(branch, data)) { matches++; continue; }' },
];

test('detection power: deliberately broken copies of the product are caught by the differential (and the unbroken copy is not)', { timeout: 600_000 }, async () => {
  const source = read('frontend/src/runtime/edits/schemaValidator.ts').replace(/\r\n/g, '\n');
  const directory = mkdtempSync(join(tmpdir(), 'schema-mutants-'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  try {
    const load = async (name: string, text: string): Promise<Validate> => {
      const file = join(directory, `${name}.ts`);
      writeFileSync(file, text);
      return (await import(pathToFileURL(file).href) as { validateStructure: Validate }).validateStructure;
    };
    const suites = (candidate: Validate): { boundary: number; definitions: number; synthetic: number } => ({
      boundary: runBoundary(validateStructureLegacy, candidate).mismatchCount,
      definitions: runDefinitionDifferential(validateStructureLegacy, candidate, schema, SEED + 2, 40).mismatchCount,
      synthetic: runSyntheticDifferential(validateStructureLegacy, candidate, SEED + 3, 300, 8).mismatchCount,
    });
    const control = suites(await load('control', source));
    assert.deepEqual(control, { boundary: 0, definitions: 0, synthetic: 0 }, 'an unmodified copy is equivalent');
    const survivors: string[] = [];
    const table: string[] = [];
    for (const [index, mutant] of MUTANTS.entries()) {
      assert.equal(source.split(mutant.from).length - 1, 1, `mutation anchor must occur exactly once: ${mutant.name}`);
      const found = suites(await load(`mutant${index}`, source.replace(mutant.from, mutant.to)));
      table.push(`#   mutant ${index + 1} (${mutant.name}): boundary ${found.boundary}, definitions ${found.definitions}, synthetic ${found.synthetic} mismatches`);
      if (found.boundary + found.definitions + found.synthetic === 0) survivors.push(mutant.name);
    }
    console.log(`# detection power, ${MUTANTS.length} mutants:\n${table.join('\n')}`);
    assert.deepEqual(survivors, [], 'every mutant must be killed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
