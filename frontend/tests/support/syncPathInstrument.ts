// B13-d U5: disposable instrumented / mutated copies of editGraph.ts and repository.ts (the sync path) for tests and measurements.
// The source text is READ (never written) from the given files; the copies go to a fresh temporary directory, their relative imports
// are rewritten to absolute file URLs of the real modules (EditRejected, applyValidatedBatch, historyStatus ... are the very same module
// instances as the product's), and the copy of repository.ts imports the copy of editGraph.ts next to it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Counts = Record<string, number>;
/** A textual change of one source file. `anchor` must occur exactly once (a missed anchor throws instead of silently testing nothing). */
export type SourceMutation = { file: 'graph' | 'repository'; anchor: string | RegExp; replacement: string };
export type RepositoryModule = typeof import('../../src/runtime/edits/repository.ts');
export type GraphModule = typeof import('../../src/runtime/edits/editGraph.ts');
export type InstrumentedSyncPath = { repository: RepositoryModule; graph: GraphModule; counts: () => Counts; reset: () => void; dispose: () => void };
const SRC = path.resolve(import.meta.dirname, '../../src/runtime/edits');
export const PRODUCT_FILES = { graph: path.join(SRC, 'editGraph.ts'), repository: path.join(SRC, 'repository.ts') };
export const LEGACY_FILES = { graph: path.join(import.meta.dirname, 'editGraphLegacy.ts'), repository: path.join(import.meta.dirname, 'repositoryLegacy.ts') };

const COUNTER = 'const __u5Count = (key: string) => { const c = ((globalThis as any).__b13dU5Counts ??= {}); c[key] = (c[key] ?? 0) + 1; };';
export function once(text: string, anchor: string | RegExp, replacement: string, what: string): string {
  if (typeof anchor !== 'string') {
    const all = [...text.matchAll(new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : anchor.flags + 'g'))];
    if (all.length !== 1) throw new Error(`anchor must occur exactly once (${what}): ${anchor.source.slice(0, 80)} (${all.length})`);
    const match = all[0];
    return text.slice(0, match.index) + match[0].replace(new RegExp(anchor.source, anchor.flags.replace('g', '')), replacement) + text.slice(match.index! + match[0].length);
  }
  const first = text.indexOf(anchor);
  if (first < 0 || text.indexOf(anchor, first + 1) >= 0) throw new Error(`anchor must occur exactly once (${what}): ${anchor.slice(0, 80)}`);
  return text.slice(0, first) + replacement + text.slice(first + anchor.length);
}
/** Inserts `code` after the last top-level import statement (imports in these files are single-statement lines). */
function afterImports(text: string, code: string): string {
  const pattern = /^import [^;]*;\r?\n/gm; let end = -1, match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) end = match.index + match[0].length;
  if (end < 0) throw new Error('no import statement');
  return text.slice(0, end) + code + '\n' + text.slice(end);
}
function rewriteImports(text: string, from: string): string {
  return text.replace(/(from ')([^']+)(';)/g, (_all, open: string, spec: string, close: string) => {
    if (/^\.\/editGraph(Legacy)?\.ts$/.test(spec)) return `${open}./editGraph.ts${close}`;
    if (!spec.startsWith('.')) return open + spec + close;
    return open + pathToFileURL(path.resolve(path.dirname(from), spec)).href + close;
  });
}
/** CRLF working copies: make an LF anchor/replacement match the file's line endings. */
const fitLineEndings = (text: string, value: string) => text.includes('\r\n') ? value.replace(/\r?\n/g, '\r\n') : value;

/** Counts (when `count`): graphBuild = EditGraph constructions, graphSnapshot = EditGraph.snapshot() calls, replay = applyValidatedBatch calls made
 * by the graph (every batch application, in receive(), in snapshot() replays and in a U5 visit), assertBindings = repository bindings checks
 * (any transaction, also the U5 first pass). Read calls are counted by the database (tests/support/syncPathDifferential.ts). */
export async function instrumentedSyncPath(options: { files?: { graph: string; repository: string }; mutations?: SourceMutation[]; count?: boolean; label?: string } = {}): Promise<InstrumentedSyncPath> {
  const files = options.files ?? PRODUCT_FILES;
  let graph = readFileSync(files.graph, 'utf8'), repository = readFileSync(files.repository, 'utf8');
  for (const mutation of options.mutations ?? []) {
    const text = mutation.file === 'graph' ? graph : repository;
    const anchor = typeof mutation.anchor === 'string' ? fitLineEndings(text, mutation.anchor) : mutation.anchor;
    const next = once(text, anchor, fitLineEndings(text, mutation.replacement), mutation.file);
    if (mutation.file === 'graph') graph = next; else repository = next;
  }
  graph = rewriteImports(graph, files.graph);
  repository = rewriteImports(repository, files.repository);
  if (options.count) {
    graph = graph.replace(/import \{ applyValidatedBatch, /, 'import { applyValidatedBatch as __u5Apply, ');
    if (!graph.includes('applyValidatedBatch as __u5Apply')) throw new Error('graph applyValidatedBatch import not found');
    graph = afterImports(graph, `${COUNTER}\nconst applyValidatedBatch = (...args: Parameters<typeof __u5Apply>) => { __u5Count('replay'); return __u5Apply(...args); };`);
    graph = once(graph, 'constructor(checkpoint: GraphCheckpoint) {', "constructor(checkpoint: GraphCheckpoint) { __u5Count('graphBuild');", 'graph constructor');
    graph = once(graph, 'snapshot(version: string): Snapshot | undefined {', "snapshot(version: string): Snapshot | undefined { __u5Count('graphSnapshot');", 'graph snapshot');
    repository = afterImports(repository, COUNTER);
    repository = once(repository, /private async assertBindings\(tx: [^,]+, snapshot: Snapshot\): Promise<void> \{/, "$& __u5Count('assertBindings');", 'assertBindings');
  }
  const dir = mkdtempSync(path.join(tmpdir(), `b13d-u5-${options.label ?? 'copy'}-`));
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(dir, 'editGraph.ts'), graph);
  writeFileSync(path.join(dir, 'repository.ts'), repository);
  const graphModule = await import(pathToFileURL(path.join(dir, 'editGraph.ts')).href);
  const repositoryModule = await import(pathToFileURL(path.join(dir, 'repository.ts')).href);
  const store = () => ((globalThis as unknown as { __b13dU5Counts?: Counts }).__b13dU5Counts ??= {});
  return {
    repository: repositoryModule, graph: graphModule,
    counts: () => ({ ...store() }),
    reset: () => { for (const key of Object.keys(store())) delete store()[key]; },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
