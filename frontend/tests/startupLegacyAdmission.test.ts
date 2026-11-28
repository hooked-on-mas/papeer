import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startGuardedApplication } from '../src/app/startup.ts';

class Element {
  readonly dataset: Record<string, string> = {};
  readonly children: Element[] = [];
  readonly listeners = new Map<string, () => void>();
  className = '';
  textContent = '';
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  setAttribute() {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children.splice(0, this.children.length, ...children); }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
async function documentFixture(action: (root: HTMLElement, nodes: Element) => Promise<void>) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document'), root = new Element('root');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  try { await action(root as unknown as HTMLElement, root); }
  finally { if (saved) Object.defineProperty(globalThis, 'document', saved); else Reflect.deleteProperty(globalThis, 'document'); }
}

test('a genuine migration hold has priority over legacy presence and never mounts', async () => documentFixture(async (root, nodes) => {
  let loaded = 0, inspected = 0;
  await startGuardedApplication(root, { readHold: async () => ({ version: 1, runId: crypto.randomUUID() }),
    readLegacyPresence: async () => { inspected++; return 'clear'; }, load: async () => { loaded++; } });
  assert.equal(root.dataset.startupState, 'held'); assert.equal(inspected, 0); assert.equal(loaded, 0);
  assert.ok(nodes.all().some(node => node.textContent.includes('移行が完了するまで')));
}));

test('legacy presence displays migration/recovery guidance and retry rechecks before mounting', async () => documentFixture(async (root, nodes) => {
  let presence: 'clear' | 'legacy-present' = 'legacy-present', loaded = 0, reads = 0;
  await startGuardedApplication(root, { readHold: async () => null,
    readLegacyPresence: async () => { reads++; return presence; }, load: async () => { loaded++; } });
  assert.equal(root.dataset.startupState, 'legacy-present'); assert.equal(loaded, 0);
  assert.ok(nodes.all().some(node => node.textContent.includes('以前の保存データ')));
  presence = 'clear'; nodes.all().find(node => node.textContent === '起動を再試行')!.listeners.get('click')!();
  await delay(0); assert.equal(root.dataset.startupState, 'running'); assert.equal(reads, 2); assert.equal(loaded, 1);
}));

test('unreadable presence stays unavailable; old hosts without the optional inquiry keep their contract', async () => documentFixture(async root => {
  let loaded = 0;
  await startGuardedApplication(root, { readHold: async () => null,
    readLegacyPresence: async () => { throw new Error('unreadable'); }, load: async () => { loaded++; } });
  assert.equal(root.dataset.startupState, 'unavailable'); assert.equal(loaded, 0);
  await startGuardedApplication(root, { readHold: async () => null, load: async () => { loaded++; } });
  assert.equal(root.dataset.startupState, 'running'); assert.equal(loaded, 1);
}));

for (const value of [null, undefined]) test(`a provided presence hook returning ${String(value)} fails closed`, async () => documentFixture(async root => {
  let loaded = 0;
  const readLegacyPresence = (async () => value) as unknown as () => Promise<'clear' | 'legacy-present'>;
  await startGuardedApplication(root, { readHold: async () => null, readLegacyPresence, load: async () => { loaded++; } });
  assert.equal(root.dataset.startupState, 'unavailable'); assert.equal(loaded, 0);
}));

test('timed out presence cannot mount after its late clear reply', async () => documentFixture(async root => {
  let resolve!: (value: 'clear') => void, loaded = 0;
  const pending = new Promise<'clear'>(done => { resolve = done; });
  await startGuardedApplication(root, { readHold: async () => null, readLegacyPresence: () => pending,
    load: async () => { loaded++; } }, { admissionTimeoutMs: 5 });
  assert.equal(root.dataset.startupState, 'unavailable'); resolve('clear'); await delay(0);
  assert.equal(loaded, 0); assert.equal(root.dataset.startupState, 'unavailable');
}));

test('explicit recovery entry mounts without admitting the normal editor', async () => documentFixture(async root => {
  let recovery = 0, editor = 0;
  await startGuardedApplication(root, { readHold: async () => ({ version: 1, runId: crypto.randomUUID() }),
    loadRecovery: async () => { recovery++; return true; }, load: async () => { editor++; } });
  assert.equal(root.dataset.startupState, 'recovery'); assert.equal(recovery, 1); assert.equal(editor, 0);
}));

test('refused recovery entry retains the original held gate', async () => documentFixture(async root => {
  let editor = 0;
  await startGuardedApplication(root, { readHold: async () => ({ version: 1, runId: crypto.randomUUID() }),
    loadRecovery: async () => false, load: async () => { editor++; } });
  assert.equal(root.dataset.startupState, 'held'); assert.equal(editor, 0);
}));

test('unavailable recovery entry remains time bounded', async () => documentFixture(async root => {
  let editor = 0;
  await startGuardedApplication(root, { readHold: async () => ({ version: 1, runId: crypto.randomUUID() }),
    loadRecovery: () => new Promise<boolean>(() => {}), load: async () => { editor++; } }, { admissionTimeoutMs: 5 });
  assert.equal(root.dataset.startupState, 'unavailable'); assert.equal(editor, 0);
}));

test('separate journal status blocks normal admission without inventing a hold', async () => documentFixture(async root => {
  let recovery = 0, editor = 0, presence = 0;
  await startGuardedApplication(root, { readHold: async () => null,
    readRecoveryRequired: async () => true, readLegacyPresence: async () => { presence++; return 'clear'; },
    loadRecovery: async () => { recovery++; return true; }, load: async () => { editor++; } });
  assert.equal(root.dataset.startupState, 'recovery'); assert.equal(recovery, 1); assert.equal(editor, 0); assert.equal(presence, 0);
}));

test('unreadable separate journal status never opens the normal editor', async () => documentFixture(async root => {
  let editor = 0;
  await startGuardedApplication(root, { readHold: async () => null,
    readRecoveryRequired: async () => { throw new Error('status-unavailable'); }, load: async () => { editor++; } });
  assert.equal(root.dataset.startupState, 'unavailable'); assert.equal(editor, 0);
}));
