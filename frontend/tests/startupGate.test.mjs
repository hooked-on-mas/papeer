import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startGuardedApplication } from '../src/app/startup.ts';
import { IndexedDbLegacyBackupStore } from '../src/adapters/browser/legacyBackupStore.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fakeDom(t) {
  const previous = globalThis.document;
  const element = () => ({ dataset: {}, children: [], listeners: {}, textContent: '',
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute() {}, addEventListener(name, callback) { this.listeners[name] = callback; } });
  globalThis.document = { createElement: element };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const root = element();
  const click = text => { const button = root.children[0].children.find(child => child.textContent === text); assert.ok(button, text); button.listeners.click(); };
  return { root, click };
}

test('an unresponsive inquiry times out, aborts and retries; stale success cannot mount', async t => {
  const { root, click } = fakeDom(t), first = deferred(), second = deferred();
  const signals = []; let loads = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const initial = startGuardedApplication(root, { readHold(signal) { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; },
    async load() { loads++; } });
  assert.equal(root.dataset.startupState, 'loading');
  t.mock.timers.tick(10_000); await initial;
  assert.equal(root.dataset.startupState, 'unavailable'); assert.equal(signals[0].aborted, true); assert.equal(loads, 0);
  click('起動を再試行');
  first.resolve(null); await flush();
  assert.equal(root.dataset.startupState, 'loading'); assert.equal(loads, 0);
  second.resolve(null); await flush();
  assert.equal(root.dataset.startupState, 'running'); assert.equal(loads, 1);
});

test('cancel and held/invalid responses stay closed and allow another inquiry', async t => {
  const { root, click } = fakeDom(t), first = deferred();
  const responses = [first.promise, Promise.resolve({ version: 1, runId: '11111111-1111-4111-8111-111111111111' }), Promise.resolve({ version: 2 }), Promise.resolve(null)];
  let loads = 0, signal;
  const initial = startGuardedApplication(root, { readHold(value) { signal = value; return responses.shift(); }, async load() { loads++; } });
  click('確認を中止'); await initial;
  assert.equal(signal.aborted, true); assert.equal(root.dataset.startupState, 'unavailable');
  click('起動を再試行'); await flush(); assert.equal(root.dataset.startupState, 'held');
  first.resolve(null); await flush(); assert.equal(loads, 0); assert.equal(root.dataset.startupState, 'held');
  click('起動を再試行'); await flush(); assert.equal(root.dataset.startupState, 'unavailable'); assert.equal(loads, 0);
  click('起動を再試行'); await flush(); assert.equal(root.dataset.startupState, 'running'); assert.equal(loads, 1);
});

test('cancellation wins even when the inquiry has resolved before its continuation runs', async t => {
  const { root, click } = fakeDom(t); let loads = 0;
  const initial = startGuardedApplication(root, { readHold: async () => null, async load() { loads++; } });
  click('確認を中止'); await initial;
  assert.equal(root.dataset.startupState, 'unavailable'); assert.equal(loads, 0);
  click('起動を再試行'); await flush();
  assert.equal(root.dataset.startupState, 'running'); assert.equal(loads, 1);
});

test('blocked and cancelled IndexedDB opens close late connections and never upgrade after cancellation', async () => {
  for (const mode of ['blocked', 'cancelled']) {
    let closes = 0, upgrades = 0, aborts = 0;
    const request = { result: { close() { closes++; }, createObjectStore() { upgrades++; }, objectStoreNames: { contains: () => false } }, transaction: { abort() { aborts++; } } };
    const store = new IndexedDbLegacyBackupStore('startup-test', { open: () => request });
    const controller = new AbortController(), inquiry = store.readHold(controller.signal);
    const rejected = assert.rejects(inquiry);
    if (mode === 'blocked') request.onblocked(); else controller.abort();
    await rejected;
    request.onupgradeneeded(); request.onsuccess();
    assert.equal(upgrades, 0); assert.equal(aborts, 1); assert.equal(closes, 1);
  }
});

test('a hung IndexedDB open passes through the common deadline and can be retried', async t => {
  const { root, click } = fakeDom(t); let opens = 0, loads = 0;
  const store = new IndexedDbLegacyBackupStore('startup-test', { open() { opens++; return {}; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const initial = startGuardedApplication(root, { readHold: signal => store.readHold(signal), async load() { loads++; } });
  t.mock.timers.tick(10_000); await initial;
  assert.equal(root.dataset.startupState, 'unavailable'); assert.equal(loads, 0);
  click('起動を再試行'); assert.equal(opens, 2);
  click('確認を中止'); await flush(); assert.equal(root.dataset.startupState, 'unavailable');
});

test('cancelling an admitted IndexedDB read aborts its readonly transaction and releases the connection', async () => {
  for (const cancel of [true, false]) {
    let closes = 0, aborts = 0;
    const tx = { objectStore: () => ({ get: () => ({ result: undefined }) }), abort() { aborts++; this.onabort(); } };
    const request = { result: { close() { closes++; }, transaction: () => tx } };
    const store = new IndexedDbLegacyBackupStore('startup-test', { open: () => request });
    const controller = new AbortController(), inquiry = store.readHold(controller.signal);
    request.onsuccess(); await flush();
    if (cancel) {
      const rejected = assert.rejects(inquiry);
      controller.abort(); await rejected; assert.equal(aborts, 1);
    } else {
      tx.oncomplete(); assert.equal(await inquiry, undefined);
      controller.abort(); assert.equal(aborts, 0);
    }
    assert.equal(closes, 1);
  }
});
