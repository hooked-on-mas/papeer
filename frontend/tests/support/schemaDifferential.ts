/**
 * Support for the differential tests of schemaValidator.ts (work B13-d U1): a seeded PRNG, a schema-driven generator of VALID values, a
 * generator of broken variants, a generator of small random synthetic schemas, and the comparison harness.
 * The thing compared is the whole observable result of a validation: "ok", or the class name and the complete message of the exception.
 * Everything is deterministic for a given seed (no Math.random, no clock).
 */
export type Loose = any;
export type Validate = (schema: Loose, name: string, value: unknown) => void;

/** mulberry32: small, fast, reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = ReturnType<typeof makeRng>;
export function makeRng(seed: number) {
  const next = mulberry32(seed);
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next, int,
    chance: (p: number): boolean => next() < p,
    pick: <T>(items: readonly T[]): T => items[int(items.length)],
    range: (low: number, high: number): number => low + int(high - low + 1),
  };
}

/** The whole observable result of one validation. */
export function outcome(validate: Validate, schema: Loose, name: string, value: unknown): string {
  try { validate(schema, name, value); return 'ok'; } catch (error) {
    if (error instanceof Error) return `${error.constructor.name}: ${error.message}`;
    return `non-error: ${String(error)}`;
  }
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : typeof item === 'number' && !Number.isFinite(item) ? `<${item}>`
      : Object.is(item, -0) ? '<-0>' : item === undefined ? '<undefined>' : typeof item === 'symbol' || typeof item === 'function' ? `<${typeof item}>` : item);
    return (text ?? 'undefined').slice(0, 400);
  } catch { return '<unprintable>'; }
}

// ---------------------------------------------------------------------------------------------------------------- valid values
const PATTERN_SAMPLERS: Record<string, (rng: Rng) => string> = {
  '^[0-9a-f]{64}$': rng => hex(rng, 64),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$': rng => `${hex(rng, 8)}-${hex(rng, 4)}-${hex(rng, 4)}-${hex(rng, 4)}-${hex(rng, 12)}`,
  '^#[0-9a-fA-F]{6}$': rng => `#${hex(rng, 6)}`,
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$': rng =>
    `20${String(rng.range(10, 39))}-0${rng.range(1, 9)}-1${rng.range(0, 9)}T0${rng.range(0, 9)}:${rng.range(10, 59)}:${rng.range(10, 59)}${rng.chance(0.5) ? `.${rng.range(1, 999999)}` : ''}Z`,
};
function hex(rng: Rng, length: number): string { let text = ''; for (let i = 0; i < length; i++) text += '0123456789abcdef'[rng.int(16)]; return text; }
const ALPHABET = ['a', 'b', 'Z', '0', ' ', '-', '_', 'あ', '漢', 'é', '́', '\u{1f600}', '\u{20bb7}', '‍'];

/** Fails (throws) on a `pattern` it has no sampler for: add one here so the generator keeps producing valid strings. */
export function sampleValid(schema: Loose, rule: Loose, rng: Rng, depth = 0): unknown {
  let current = rule;
  for (let hops = 0; current.$ref; hops++) { if (hops > 32) throw new Error('sampler: $ref chain too long'); current = schema.$defs[current.$ref.split('/').pop()!]; }
  if ('const' in current) return current.const;
  if (current.enum) return rng.pick(current.enum);
  if (current.oneOf) return sampleValid(schema, rng.pick(current.oneOf as Loose[]), rng, depth);
  switch (current.type) {
    case 'null': return null;
    case 'boolean': return rng.chance(0.5);
    case 'string': {
      if (current.pattern) {
        const sampler = PATTERN_SAMPLERS[current.pattern as string];
        if (!sampler) throw new Error(`sampler: no generator for pattern ${current.pattern}`);
        return sampler(rng);
      }
      const min = current.minLength ?? 0;
      const max = Math.min(current.maxLength ?? min + 10, min + 10);
      const size = rng.range(min, max);
      let text = '';
      for (let i = 0; i < size; i++) text += rng.pick(ALPHABET);
      return text;
    }
    case 'integer': {
      const low = current.minimum ?? (current.exclusiveMinimum !== undefined ? Math.floor(current.exclusiveMinimum) + 1 : 0);
      const high = Math.min(current.maximum ?? low + 1000, low + 1000);
      return rng.range(low, high);
    }
    case 'number': {
      const low = current.minimum ?? (current.exclusiveMinimum !== undefined ? current.exclusiveMinimum + 0.5 : -100);
      const high = Math.min(current.maximum ?? low + 1000, low + 1000);
      const value = low + rng.next() * (high - low);
      return current.exclusiveMinimum !== undefined && value <= current.exclusiveMinimum ? current.exclusiveMinimum + 1 : value;
    }
    case 'array': {
      const min = current.minItems ?? 0;
      const size = rng.range(min, Math.min(current.maxItems ?? min + 3, min + 3));
      return Array.from({ length: size }, () => sampleValid(schema, current.items, rng, depth + 1));
    }
    case 'object': {
      const object: Record<string, unknown> = {};
      const required = new Set<string>(current.required ?? []);
      for (const [key, property] of Object.entries<Loose>(current.properties ?? {})) {
        if (required.has(key) || rng.chance(0.6)) object[key] = sampleValid(schema, property, rng, depth + 1);
      }
      if (current.additionalProperties && typeof current.additionalProperties === 'object') {
        for (let i = rng.range(0, 2); i > 0; i--) object[`k${rng.int(1000)}`] = sampleValid(schema, current.additionalProperties, rng, depth + 1);
      }
      return object;
    }
    default: throw new Error(`sampler: unsupported rule ${JSON.stringify(current).slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------- broken variants
const SCALARS: unknown[] = [null, true, false, 0, -0, 1, -1, 1.5, 2 ** 53, -(2 ** 53), 1e308, 5e-324, NaN, Infinity, -Infinity, 10n, undefined, '', 'x', 'a'.repeat(300),
  '\ud800', '\udc00', 'a\ud800b', '\ud83d', '\u{1f600}', '\u0000', 'path', 'line', 'document', 'markdown', 'library', 'put-item', '\n'];
const OTHER_VALUES = (): unknown[] => [...SCALARS, [], [null], [[]], {}, { kind: 'path' }, { kind: 'x' }, { a: 1 }, Object.create(null), new Date(0), new Map(), /x/, Symbol('s'),
  Object.create({ kind: 'inherited' }), new (class Klass { kind = 'path'; })()];

type Node = { parent: Loose; key: string | number | null; value: unknown };
function collect(value: unknown, parent: Loose, key: string | number | null, out: Node[], depth = 0): void {
  out.push({ parent, key, value });
  if (depth > 12 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) value.forEach((item, index) => collect(item, value, index, out, depth + 1));
  else {
    let entries: [string, unknown][] = [];
    try { entries = Object.entries(value); } catch { /* an earlier damage installed a throwing getter or trap: do not descend */ }
    for (const [childKey, item] of entries) collect(item, value, childKey, out, depth + 1);
  }
}
/** Deep copy that keeps null-prototype objects, so every mutation works on a private tree. */
export function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const copy: Record<string, unknown> = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
    for (const [key, item] of Object.entries(value)) copy[key] = deepCopy(item);
    return copy;
  }
  return value;
}

function discriminators(schema: Loose): string[] {
  const found = new Set<string>();
  const walk = (node: Loose): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (typeof node.const === 'string') found.add(node.const);
      Object.values(node).forEach(walk);
    }
  };
  walk(schema);
  return [...found].sort();
}

function replace(node: Node, replacement: unknown): unknown {
  if (node.parent === null) return replacement;
  node.parent[node.key as string] = replacement;
  return undefined;
}

/** Applies 1..3 random damages to a private copy of `valid` (a valid value, or any value). Returns the broken variant. */
export function breakValue(schema: Loose, valid: unknown, rng: Rng, extraSamples: () => unknown): unknown {
  const kinds = discriminators(schema);
  let root = deepCopy(valid);
  for (let round = rng.range(1, 3); round > 0; round--) {
    const nodes: Node[] = [];
    collect(root, null, null, nodes);
    const node = rng.pick(nodes);
    const target = node.value as Loose;
    const isObject = target !== null && typeof target === 'object' && !Array.isArray(target);
    const choice = rng.int(20);
    let replaced: unknown;
    try {
    switch (choice) {
      case 0: case 1: // delete a key
        if (isObject && Object.keys(target).length) delete target[rng.pick(Object.keys(target))]; else replaced = replace(node, rng.pick(OTHER_VALUES()));
        break;
      case 2: case 3: case 4: replaced = replace(node, rng.pick(OTHER_VALUES())); break; // swap the type
      case 5: case 6: case 7: // rewrite the discriminator (`kind`, `type`, ...)
        if (isObject) {
          const keys = Object.keys(target).filter(key => ['kind', 'type', 'provider', 'action', 'state', 'head', 'phase'].includes(key));
          const key = keys.length ? rng.pick(keys) : 'kind';
          target[key] = rng.chance(0.7) ? rng.pick(kinds) : rng.pick(OTHER_VALUES());
        } else replaced = replace(node, rng.pick(kinds));
        break;
      case 8: // extra key (also awkward names)
        if (isObject) {
          const key = rng.pick(['extra', '', 'kind', '__proto__', 'constructor', '\ud800', 'a\udc00', 'toString', '0']);
          Object.defineProperty(target, key, { value: rng.pick(OTHER_VALUES()), enumerable: true, writable: true, configurable: true });
        } else replaced = replace(node, rng.pick(OTHER_VALUES()));
        break;
      case 9: // null <-> number
        replaced = replace(node, target === null ? rng.pick([0, 1, -0, NaN]) : typeof target === 'number' ? null : rng.pick([null, 0]));
        break;
      case 10: // prototype-less object (valid), or a foreign prototype (invalid)
        if (isObject) {
          const copy: Record<string, unknown> = rng.chance(0.6) ? Object.create(null) : Object.create(rng.pick([{}, Object.create(null), Array.prototype, { kind: 'path' }]));
          for (const [key, item] of Object.entries(target)) Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
          replaced = replace(node, copy);
        } else replaced = replace(node, Object.create(null));
        break;
      case 11: case 12: // numbers
        replaced = replace(node, rng.pick([NaN, Infinity, -Infinity, -0, 0, 1, -1, 1.5, 2 ** 53, 2 ** 53 - 1, -(2 ** 53 - 1), 1e21, Number.MIN_VALUE, 1e-7, 0.5]));
        break;
      case 13: case 14: // strings
        if (typeof target === 'string') replaced = replace(node, rng.pick([target + '\ud800', '\udc00' + target, target + '\n', target.toUpperCase(), target.slice(1), target + target, `${target}\u{1f600}`, '']));
        else replaced = replace(node, rng.pick(['\ud800', 'a\ud800', '\n', ' ']));
        break;
      case 15: // arrays
        if (Array.isArray(target)) {
          const how = rng.int(5);
          if (how === 0) target.length = 0;
          else if (how === 1 && target.length) target.push(target[0]);
          else if (how === 2) target.length += 2; // holes
          else if (how === 3 && target.length) target.pop();
          else target.push(rng.pick(OTHER_VALUES()));
        } else replaced = replace(node, rng.chance(0.5) ? [] : [target]);
        break;
      case 16: // property attributes: accessor, non-enumerable, symbol key, throwing getter
        if (isObject) {
          const key = rng.chance(0.7) ? 'kind' : (Object.keys(target)[0] ?? 'kind');
          const present = Object.prototype.hasOwnProperty.call(target, key);
          let current: unknown = rng.pick(kinds);
          if (present) { try { current = target[key]; } catch { /* keep the generated kind */ } }
          const how = rng.int(5);
          if (how === 0) Object.defineProperty(target, key, { value: rng.chance(0.5) ? current : rng.pick(kinds), enumerable: false, writable: true, configurable: true });
          else if (how === 1) Object.defineProperty(target, key, { get: () => current, enumerable: true, configurable: true });
          else if (how === 2) Object.defineProperty(target, key, { get: () => { throw new RangeError('getter'); }, enumerable: true, configurable: true });
          else if (how === 3) Object.defineProperty(target, Symbol('s'), { value: 1, enumerable: true });
          else { const other = rng.pick(kinds); Object.defineProperty(target, key, { get: () => other, enumerable: true, configurable: true }); } // a getter must be pure: both implementations read the same object
        } else replaced = replace(node, rng.pick(OTHER_VALUES()));
        break;
      case 17: // Proxy: transparent, or with throwing traps
        if (target !== null && typeof target === 'object') {
          const how = rng.int(4);
          const handler: ProxyHandler<object> = how === 0 ? {} : how === 1 ? { getOwnPropertyDescriptor: () => { throw new TypeError('trap'); } }
            : how === 2 ? { getPrototypeOf: () => { throw new TypeError('trap'); } } : { ownKeys: () => { throw new TypeError('trap'); } };
          replaced = replace(node, new Proxy(target, handler));
        } else replaced = replace(node, rng.pick(OTHER_VALUES()));
        break;
      case 18: // graft a valid value of some other definition here
        replaced = replace(node, extraSamples());
        break;
      default: // sibling's discriminator on a differently shaped object
        if (isObject) { target.kind = rng.pick(kinds); if (rng.chance(0.5)) delete target.type; } else replaced = replace(node, extraSamples());
    }
    } catch { /* an earlier damage made this node untouchable (throwing trap): skip this round */ }
    if (node.parent === null && replaced !== undefined) root = replaced;
  }
  return root;
}

// ---------------------------------------------------------------------------------------------------------------- comparison
export type Mismatch = { name: string; reference: string; candidate: string; value: string };
/** `mismatches` keeps the first 12 for diagnosis; `mismatchCount` is the true number. */
export type Report = { cases: number; accepted: number; rejected: number; distinctOutcomes: number; mismatchCount: number; mismatches: Mismatch[] };

export function newReport(): Report & { outcomes: Set<string> } { return { cases: 0, accepted: 0, rejected: 0, distinctOutcomes: 0, mismatchCount: 0, mismatches: [], outcomes: new Set() }; }
export function compareOne(report: ReturnType<typeof newReport>, reference: Validate, candidate: Validate, schema: Loose, name: string, value: unknown): void {
  const expected = outcome(reference, schema, name, value);
  const actual = outcome(candidate, schema, name, value);
  report.cases++;
  if (expected === 'ok') report.accepted++; else report.rejected++;
  report.outcomes.add(expected);
  if (expected !== actual) {
    report.mismatchCount++;
    if (report.mismatches.length < 12) report.mismatches.push({ name, reference: expected, candidate: actual, value: safeJson(value) });
  }
}
export function finish(report: ReturnType<typeof newReport>): Report {
  return { cases: report.cases, accepted: report.accepted, rejected: report.rejected, distinctOutcomes: report.outcomes.size, mismatchCount: report.mismatchCount, mismatches: report.mismatches };
}

/** Every definition x (a valid value, and `variants` broken variants of fresh valid values). */
export function runDefinitionDifferential(reference: Validate, candidate: Validate, schema: Loose, seed: number, variants: number): Report {
  const rng = makeRng(seed);
  const report = newReport();
  const names = Object.keys(schema.$defs);
  const anySample = (): unknown => sampleValid(schema, { $ref: `#/$defs/${rng.pick(names)}` }, rng);
  for (const name of names) {
    const rule = { $ref: `#/$defs/${name}` };
    for (let i = 0; i < Math.max(8, variants >> 3); i++) compareOne(report, reference, candidate, schema, name, sampleValid(schema, rule, rng));
    for (let i = 0; i < variants; i++) compareOne(report, reference, candidate, schema, name, breakValue(schema, sampleValid(schema, rule, rng), rng, anySample));
  }
  return finish(report);
}

/** Every sub-value of the given JSON documents against every definition (documents are real fixtures, so most subtrees are valid for their own definition). */
export function runSubtreeDifferential(reference: Validate, candidate: Validate, schema: Loose, documents: unknown[]): Report {
  const report = newReport();
  const names = Object.keys(schema.$defs);
  for (const document of documents) {
    const nodes: Node[] = [];
    collect(document, null, null, nodes);
    for (const node of nodes) for (const name of names) compareOne(report, reference, candidate, schema, name, node.value);
  }
  return finish(report);
}

// ---------------------------------------------------------------------------------------------------------------- random synthetic schemas
/**
 * Small random schemas over exactly the keywords schemaValidator understands. `$ref`s only point to HIGHER-numbered definitions (acyclic, so the
 * reference implementation always terminates) plus an occasional unresolvable one. Cyclic chains are tested by hand-written cases instead.
 */
export function randomSchema(rng: Rng): Loose {
  const count = rng.range(3, 6);
  const defs: Record<string, Loose> = {};
  const constants = (): unknown => rng.pick<unknown>([null, 0, 1, -0, '', 'a', 'b', 'x', true, false, NaN, 'path', 'line']);
  const leaf = (): Loose => {
    switch (rng.int(8)) {
      case 0: return { const: constants() };
      case 1: return { enum: Array.from({ length: rng.range(1, 3) }, constants) };
      case 2: return { type: 'null' };
      case 3: return { type: 'boolean' };
      case 4: return { type: 'string', ...(rng.chance(0.4) ? { minLength: rng.range(0, 2) } : {}), ...(rng.chance(0.2) ? { maxLength: rng.range(1, 3) } : {}), ...(rng.chance(0.2) ? { pattern: '^[ab]+$' } : {}) };
      case 5: return { type: rng.pick(['integer', 'number']), ...(rng.chance(0.3) ? { minimum: 0 } : {}), ...(rng.chance(0.2) ? { exclusiveMinimum: 0 } : {}) };
      case 6: return { type: 'string' };
      default: return { type: 'number', maximum: 10 };
    }
  };
  const ref = (index: number): Loose => (index + 1 < count && rng.chance(0.85)) ? { $ref: `#/$defs/D${rng.range(index + 1, count - 1)}` } : rng.chance(0.2) ? { $ref: '#/$defs/Missing' } : leaf();
  const rule = (index: number, depth: number): Loose => {
    const pickRule = rng.int(depth > 1 ? 3 : 9);
    switch (pickRule) {
      case 0: return leaf();
      case 1: return ref(index);
      case 2: return leaf();
      case 3: case 4: { // object with an (optional) discriminator
        const properties: Record<string, Loose> = {};
        if (rng.chance(0.85)) properties.kind = rng.chance(0.75) ? { const: rng.pick(['a', 'b', 'path', 'line']) } : rng.chance(0.5) ? ref(index) : { enum: ['a', 'b'] };
        if (rng.chance(0.6)) properties.v = rule(index, depth + 1);
        if (rng.chance(0.3)) properties.w = rule(index, depth + 1);
        const required = Object.keys(properties).filter(key => key === 'kind' ? rng.chance(0.8) : rng.chance(0.4));
        return { type: 'object', properties, ...(required.length || rng.chance(0.5) ? { required } : {}), ...(rng.chance(0.7) ? { additionalProperties: rng.pick([false, true, leaf()]) } : {}) };
      }
      case 5: return { type: 'array', items: rule(index, depth + 1), ...(rng.chance(0.3) ? { minItems: 1 } : {}), ...(rng.chance(0.2) ? { maxItems: 2 } : {}) };
      case 6: case 7: return { oneOf: Array.from({ length: rng.range(1, 4) }, () => rule(index, depth + 1)) };
      default: // oneOf mixed with other keywords (precedence matters), or $ref with extras
        return rng.chance(0.5) ? { oneOf: [rule(index, depth + 1), rule(index, depth + 1)], type: rng.pick(['string', 'object', 'null']) }
          : { ...ref(index), ...(rng.chance(0.5) ? { const: constants() } : { type: 'string' }) };
    }
  };
  for (let index = 0; index < count; index++) defs[`D${index}`] = rule(index, 0);
  return { $defs: defs };
}

const SYNTHETIC_VALUES = (rng: Rng): unknown[] => {
  const scalars = [null, 0, 1, -0, 1.5, 11, NaN, Infinity, '', 'a', 'b', 'ab', 'abc', 'x', 'path', 'line', true, false, '\ud800', undefined, 10n];
  const object = (): unknown => {
    const value: Record<string, unknown> = {};
    if (rng.chance(0.8)) value.kind = rng.pick<unknown>(['a', 'b', 'path', 'line', 'zzz', null, 0, undefined]);
    if (rng.chance(0.5)) value.v = rng.pick<unknown>([...scalars, [], {}, { kind: 'a' }, [1]]);
    if (rng.chance(0.2)) value.w = rng.pick<unknown>(scalars);
    if (rng.chance(0.15)) value.extra = 1;
    if (rng.chance(0.1)) Object.defineProperty(value, 'kind', { value: rng.pick(['a', 'b']), enumerable: false });
    return rng.chance(0.1) ? Object.assign(Object.create(null), value) : value;
  };
  return [...scalars, [], [1], ['a', 'b'], [null], [object()], object(), object(), object(), object(), {}];
};

export function runSyntheticDifferential(reference: Validate, candidate: Validate, seed: number, schemas: number, perSchema: number): Report {
  const rng = makeRng(seed);
  const report = newReport();
  for (let s = 0; s < schemas; s++) {
    const schema = randomSchema(rng);
    for (const name of Object.keys(schema.$defs)) {
      for (let i = 0; i < perSchema; i++) {
        const base = rng.pick(SYNTHETIC_VALUES(rng));
        compareOne(report, reference, candidate, schema, name, rng.chance(0.3) ? breakValue(schema, base, rng, () => rng.pick(SYNTHETIC_VALUES(rng))) : base);
      }
    }
  }
  return finish(report);
}
