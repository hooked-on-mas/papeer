// B13-d U2: disposable instrumented / mutated copies of libraryHistory.ts and LibrarySession.ts for tests and measurements.
// The source text is READ (never written) from the given files; the copies go to a fresh temporary directory, their relative
// imports are rewritten to absolute file URLs of the real modules (so EditRejected, EditGraph, applyBatch ... are the very same
// module instances as the product's), and the copy of LibrarySession imports the copy of libraryHistory next to it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Counts = Record<string, number>;
/** A textual change of one source file. `anchor` must occur exactly once (a missed anchor throws instead of silently testing nothing). */
export type SourceMutation = { file: 'history' | 'session'; anchor: string; replacement: string };
export type InstrumentedModules = {
  history: typeof import('../../src/features/library/libraryHistory.ts');
  session: typeof import('../../src/features/library/LibrarySession.ts');
  counts: () => Counts; reset: () => void; dispose: () => void;
};
const SRC = path.resolve(import.meta.dirname, '../../src/features/library');
export const PRODUCT_FILES = { history: path.join(SRC, 'libraryHistory.ts'), session: path.join(SRC, 'LibrarySession.ts') };
export const LEGACY_FILES = { history: path.join(import.meta.dirname, 'libraryHistoryLegacy.ts'), session: path.join(import.meta.dirname, 'librarySessionLegacy.ts') };

const COUNTER = 'const __u2Count = (key: string) => { const c = ((globalThis as any).__b13dU2Counts ??= {}); c[key] = (c[key] ?? 0) + 1; };';
function once(text: string, anchor: string, replacement: string, what: string): string {
  const first = text.indexOf(anchor);
  if (first < 0 || text.indexOf(anchor, first + 1) >= 0) throw new Error(`anchor must occur exactly once (${what}): ${anchor.slice(0, 80)}`);
  return text.slice(0, first) + replacement + text.slice(first + anchor.length);
}
/** Inserts `code` after the last top-level import statement (imports in these files are single-statement, possibly multi-line). */
function afterImports(text: string, code: string): string {
  const pattern = /^import [^;]*;\r?\n/gm; let end = -1, match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) end = match.index + match[0].length;
  if (end < 0) throw new Error('no import statement');
  return text.slice(0, end) + code + '\n' + text.slice(end);
}
function rewriteImports(text: string, from: string, historySibling: boolean): string {
  return text.replace(/(from ')([^']+)(';)/g, (_all, open: string, spec: string, close: string) => {
    if (historySibling && /^\.\/libraryHistory(Legacy)?\.ts$/.test(spec)) return `${open}./libraryHistory.ts${close}`;
    if (!spec.startsWith('.')) return open + spec + close;
    return open + pathToFileURL(path.resolve(path.dirname(from), spec)).href + close;
  });
}

/** Counts (when `count`): historyApplyBatch = applyBatch calls made by libraryHistory, sessionEditGraph = EditGraph constructions by
 * LibrarySession, sessionGraphSnapshot = snapshot() calls on those graphs, sessionApplyBatch = applyBatch calls made by LibrarySession. */
export async function instrumentedModules(options: { files?: { history: string; session: string }; mutations?: SourceMutation[]; count?: boolean; label?: string } = {}): Promise<InstrumentedModules> {
  const files = options.files ?? PRODUCT_FILES;
  let history = readFileSync(files.history, 'utf8'), session = readFileSync(files.session, 'utf8');
  for (const mutation of options.mutations ?? []) {
    if (mutation.file === 'history') history = once(history, mutation.anchor, mutation.replacement, 'history');
    else session = once(session, mutation.anchor, mutation.replacement, 'session');
  }
  history = rewriteImports(history, files.history, false);
  session = rewriteImports(session, files.session, true);
  if (options.count) {
    history = afterImports(history.replace(/import \{ applyBatch, /, 'import { applyBatch as __u2ApplyBatch, '),
      `${COUNTER}\nconst applyBatch = (...args: Parameters<typeof __u2ApplyBatch>) => { __u2Count('historyApplyBatch'); return __u2ApplyBatch(...args); };`);
    if (!history.includes('applyBatch as __u2ApplyBatch')) throw new Error('history applyBatch import not found');
    session = session.replace(/import \{ EditGraph \} from /, 'import { EditGraph as __U2EditGraph } from ')
      .replace(/import \{ applyBatch, canonicalJson \} from /, 'import { applyBatch as __u2ApplyBatch, canonicalJson } from ');
    if (!session.includes('EditGraph as __U2EditGraph') || !session.includes('applyBatch as __u2ApplyBatch')) throw new Error('session imports not found');
    session = afterImports(session, `${COUNTER}
class EditGraph extends __U2EditGraph {
  constructor(checkpoint: ConstructorParameters<typeof __U2EditGraph>[0]) { __u2Count('sessionEditGraph'); super(checkpoint); }
  snapshot(version: string) { __u2Count('sessionGraphSnapshot'); return super.snapshot(version); }
}
const applyBatch = (...args: Parameters<typeof __u2ApplyBatch>) => { __u2Count('sessionApplyBatch'); return __u2ApplyBatch(...args); };`);
  }
  const dir = mkdtempSync(path.join(tmpdir(), `b13d-u2-${options.label ?? 'copy'}-`));
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(dir, 'libraryHistory.ts'), history);
  writeFileSync(path.join(dir, 'LibrarySession.ts'), session);
  const historyModule = await import(pathToFileURL(path.join(dir, 'libraryHistory.ts')).href);
  const sessionModule = await import(pathToFileURL(path.join(dir, 'LibrarySession.ts')).href);
  const store = () => ((globalThis as unknown as { __b13dU2Counts?: Counts }).__b13dU2Counts ??= {});
  return {
    history: historyModule, session: sessionModule,
    counts: () => ({ ...store() }),
    reset: () => { for (const key of Object.keys(store())) delete store()[key]; },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
