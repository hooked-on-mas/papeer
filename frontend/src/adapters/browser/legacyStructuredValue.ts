import { EditRejected } from '../../runtime/edits/editModel.ts';
import { resourceHash } from '../../runtime/edits/contentPublication.ts';

type Atom = ['null'] | ['undefined'] | ['boolean', boolean] | ['string', string] | ['number', number | string] | ['bigint', string] | ['ref', number];
type Node =
  | { kind: 'object'; nullPrototype: boolean; entries: [string, Atom][] }
  | { kind: 'array'; length: number; entries: [string, Atom][] }
  | { kind: 'map'; entries: [Atom, Atom][] } | { kind: 'set'; entries: Atom[] }
  | { kind: 'date'; time: Atom } | { kind: 'regexp'; source: string; flags: string }
  | { kind: 'buffer'; hash: string; byteLength: number }
  | { kind: 'blob'; hash: string; byteLength: number; type: string; file: { name: string; lastModified: number } | null }
  | { kind: 'view'; name: string; buffer: Atom; byteOffset: number; byteLength: number };
type Graph = { version: 1; root: Atom; nodes: Node[] };
const views = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array };

/** Lossless structured-clone input, separate from the canonical edit model. Binary bodies are content addressed.
 * Unexpected platform objects fail capture rather than disappearing from a supposedly complete backup. */
export async function encodeLegacyValue(value: unknown): Promise<{ bytes: Uint8Array; objects: Map<string, Uint8Array> }> {
  const nodes: Node[] = [], seen = new Map<object, number>(), objects = new Map<string, Uint8Array>();
  const binary = async (bytes: Uint8Array) => {
    const hash = await resourceHash(bytes); objects.set(hash, bytes); return { hash, byteLength: bytes.byteLength };
  };
  const visit = async (value: unknown): Promise<Atom> => {
    if (value === null) return ['null'];
    if (value === undefined) return ['undefined'];
    if (typeof value === 'boolean') return ['boolean', value];
    if (typeof value === 'string') return ['string', value];
    if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : Number.isNaN(value) ? 'NaN' : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : value];
    if (typeof value === 'bigint') return ['bigint', String(value)];
    if (typeof value !== 'object') throw new EditRejected('backup-value-unsupported');
    const old = seen.get(value); if (old !== undefined) return ['ref', old];
    const index = nodes.length; seen.set(value, index); nodes.push(undefined as unknown as Node);
    let node: Node;
    if (value instanceof ArrayBuffer) node = { kind: 'buffer', ...await binary(Uint8Array.from(new Uint8Array(value))) };
    else if (ArrayBuffer.isView(value)) {
      const name = value instanceof DataView ? 'DataView' : Object.entries(views).find(([, Type]) => value.constructor === Type)?.[0];
      if (!name) throw new EditRejected('backup-value-unsupported');
      node = { kind: 'view', name, buffer: await visit(value.buffer), byteOffset: value.byteOffset, byteLength: value.byteLength };
    } else if (value instanceof Blob) node = { kind: 'blob', ...await binary(new Uint8Array(await value.arrayBuffer())), type: value.type,
      file: typeof File !== 'undefined' && value instanceof File ? { name: value.name, lastModified: value.lastModified } : null };
    else if (value instanceof Date) node = { kind: 'date', time: await visit(value.getTime()) };
    else if (value instanceof RegExp) node = { kind: 'regexp', source: value.source, flags: value.flags };
    else if (value instanceof Map) {
      const entries: [Atom, Atom][] = []; for (const [key, item] of value) entries.push([await visit(key), await visit(item)]);
      node = { kind: 'map', entries };
    } else if (value instanceof Set) {
      const entries: Atom[] = []; for (const item of value) entries.push(await visit(item)); node = { kind: 'set', entries };
    } else {
      if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new EditRejected('backup-value-unsupported');
      const entries: [string, Atom][] = [];
      for (const key of Object.keys(value)) entries.push([key, await visit((value as Record<string, unknown>)[key])]);
      node = Array.isArray(value) ? { kind: 'array', length: value.length, entries }
        : { kind: 'object', nullPrototype: Object.getPrototypeOf(value) === null, entries };
    }
    nodes[index] = node; return ['ref', index];
  };
  const root = await visit(value), graph: Graph = { version: 1, root, nodes };
  return { bytes: new TextEncoder().encode(JSON.stringify(graph)), objects };
}

/** Read only verified backup bodies. Re-encoding validates the entire graph, including unused/extra nodes. */
export async function decodeLegacyValue(bytes: Uint8Array, object: (hash: string, byteLength: number) => Promise<Uint8Array>): Promise<unknown> {
  const graph = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Graph;
  if (graph.version !== 1 || !Array.isArray(graph.nodes)) throw new EditRejected('backup-value-format');
  const values = new Map<number, unknown>(), constructing = new Set<number>();
  const binary = async (node: { hash: string; byteLength: number }) => {
    if (!/^[a-f0-9]{64}$/.test(node.hash) || !Number.isSafeInteger(node.byteLength) || node.byteLength < 0) throw new EditRejected('backup-value-format');
    const bytes = Uint8Array.from(await object(node.hash, node.byteLength));
    if (bytes.byteLength !== node.byteLength || await resourceHash(bytes) !== node.hash) throw new EditRejected('backup-object-hash');
    return bytes;
  };
  const visit = async (atom: Atom): Promise<unknown> => {
    if (!Array.isArray(atom)) throw new EditRejected('backup-value-format');
    switch (atom[0]) {
      case 'null': return null;
      case 'undefined': return undefined;
      case 'string': if (typeof atom[1] === 'string') return atom[1]; break;
      case 'boolean': if (typeof atom[1] === 'boolean') return atom[1]; break;
      case 'bigint': if (typeof atom[1] === 'string' && /^-?\d+$/.test(atom[1])) return BigInt(atom[1]); break;
      case 'number': {
        const n = atom[1]; if (typeof n === 'number' && Number.isFinite(n)) return n;
        if (n === '-0') return -0; if (n === 'NaN') return NaN; if (n === 'Infinity') return Infinity; if (n === '-Infinity') return -Infinity;
        break;
      }
      case 'ref': return materialize(atom[1]);
    }
    throw new EditRejected('backup-value-format');
  };
  const materialize = async (index: number): Promise<unknown> => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= graph.nodes.length) throw new EditRejected('backup-value-reference');
    if (values.has(index)) return values.get(index);
    if (constructing.has(index)) throw new EditRejected('backup-value-reference');
    constructing.add(index);
    const node = graph.nodes[index]; let value: unknown;
    switch (node.kind) {
      case 'object': case 'array': {
        value = node.kind === 'array' ? new Array(node.length) : Object.create(node.nullPrototype ? null : Object.prototype);
        values.set(index, value);
        for (const [key, atom] of node.entries) Object.defineProperty(value, key, { value: await visit(atom), enumerable: true, writable: true, configurable: true });
        break;
      }
      case 'map': {
        const map = new Map(); values.set(index, map); for (const [key, atom] of node.entries) map.set(await visit(key), await visit(atom)); value = map; break;
      }
      case 'set': {
        const set = new Set(); values.set(index, set); for (const atom of node.entries) set.add(await visit(atom)); value = set; break;
      }
      case 'date': { const time = await visit(node.time); if (typeof time !== 'number') throw new EditRejected('backup-value-format'); value = new Date(time); break; }
      case 'regexp': value = new RegExp(node.source, node.flags); break;
      case 'buffer': value = (await binary(node)).buffer; break;
      case 'blob': {
        const body = (await binary(node)).buffer as ArrayBuffer;
        value = node.file === null ? new Blob([body], { type: node.type }) : new File([body], node.file.name, { type: node.type, lastModified: node.file.lastModified });
        break;
      }
      case 'view': {
        const buffer = await visit(node.buffer); if (!(buffer instanceof ArrayBuffer)) throw new EditRejected('backup-value-format');
        if (node.name === 'DataView') value = new DataView(buffer, node.byteOffset, node.byteLength);
        else {
          if (!Object.prototype.hasOwnProperty.call(views, node.name)) throw new EditRejected('backup-value-format');
          const Type = views[node.name as keyof typeof views];
          value = new Type(buffer, node.byteOffset, node.byteLength / Type.BYTES_PER_ELEMENT);
        }
        break;
      }
      default: throw new EditRejected('backup-value-format');
    }
    values.set(index, value); constructing.delete(index); return value;
  };
  const value = await visit(graph.root), encoded = await encodeLegacyValue(value);
  if (new TextDecoder().decode(encoded.bytes) !== JSON.stringify(graph)) throw new EditRejected('backup-value-format');
  return value;
}
