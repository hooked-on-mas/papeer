import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as places from '../src/features/reader/navigation/readingPlace.ts';

const hookSource = readFileSync(new URL('../src/web/usePdfReadingPlace.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

// Execute the real hook's effects against a small measured pane. No browser or PDF rasterization is needed.
function runHook(positionEnabled) {
  const effects = [], cleanups = [], observers = [], widths = [], scrolls = [], writes = [], listeners = [];
  const landing = { toEnd: true, consumed: new Set() };
  const surface = { getBoundingClientRect: () => ({ top: 0, left: 0, width: 600, height: 1200 }), style: {}, querySelector: () => ({}) };
  const pane = { scrollTop: 0, scrollLeft: 0, clientWidth: 600, clientHeight: 400, clientTop: 0, clientLeft: 0,
    getBoundingClientRect: () => ({ top: 0, left: 0 }), scrollTo: (...values) => scrolls.push(values),
    addEventListener: name => listeners.push(name), removeEventListener() {} };
  const root = { closest: () => pane, querySelector: () => surface };
  const react = { useContext: () => landing, useMemo: fn => fn(), useRef: value => ({ current: value }), useCallback: fn => fn,
    useLayoutEffect: fn => effects.push(fn), useEffect: fn => effects.push(fn) };
  class Observer { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} }
  const globals = { addEventListener: name => listeners.push(name), removeEventListener() {}, visibilityState: 'visible' };
  const exports = {};
  const require = name => name === 'react' ? react : name.includes('ReadingLanding') ? { ReadingLanding: {} } : places;
  new Function('require', 'exports', 'ResizeObserver', 'window', 'document', compiled)(require, exports, Observer, globals, globals);
  const persistence = { get: () => { writes.push('get'); return { x: .4, y: .3 }; }, remember: () => writes.push('remember'), flush: () => writes.push('flush') };
  exports.usePdfReadingPlace({ current: root }, { key: 'pdf:1', storageKey: 'saved', page: 1, fitPage: false, width: 600, pageWidth: 600, ready: true },
    width => widths.push(width), persistence, positionEnabled);
  for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  for (const width of [500, 350]) for (const observer of observers) observer.callback([{ contentRect: { width } }]);
  for (const cleanup of cleanups.reverse()) cleanup();
  return { widths, scrolls, writes, listeners, landing };
}

test('external reading state observes pane width without consuming landing, moving scroll or writing legacy positions', () => {
  const result = runHook(false);
  assert.deepEqual(result.widths, [500, 350]);
  assert.deepEqual(result.scrolls, []); assert.deepEqual(result.writes, []); assert.deepEqual(result.listeners, []);
  assert.equal(result.landing.consumed.size, 0);
});

test('legacy callers retain their default landing, scroll tracking and persistence behavior', () => {
  const result = runHook(undefined);
  assert.deepEqual(result.widths, [500, 350]); assert.ok(result.scrolls.length > 0);
  assert.ok(result.writes.includes('remember')); assert.ok(result.writes.includes('flush'));
  assert.ok(result.listeners.includes('scroll')); assert.ok(result.listeners.includes('pagehide'));
  assert.equal(result.landing.consumed.size, 1);
});

test('PdfReader external ownership disables legacy fit scrolling and normalization while retaining the width hook', () => {
  const source = readFileSync(new URL('../src/web/PdfReader.tsx', import.meta.url), 'utf8');
  assert.match(source, /externalReadingState = false/);
  assert.match(source, /if \(fitPage && !externalReadingState\) pane\.scrollTo\(0, 0\)/);
  assert.match(source, /if \(externalReadingState \|\| normalized\.current[^\n]+\) return/);
  assert.match(source, /usePdfReadingPlace\([^\n]+setWidth, readingPlace, !externalReadingState\)/);
});
