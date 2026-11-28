import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchStartupWithRetry } from '../src/adapters/desktop/startup/fetchStartupWithRetry.ts';
import { startGuardedApplication } from '../src/app/startup.ts';

class Element {
  dataset: Record<string, string> = {}; children: Element[] = []; listeners = new Map<string, () => void>();
  className = ''; textContent = ''; type = '';
  setAttribute() {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
async function fixture(action: (root: HTMLElement, node: Element) => Promise<void>) {
  const document = Object.getOwnPropertyDescriptor(globalThis, 'document'), fetch = globalThis.fetch, root = new Element();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element() } });
  try { await action(root as unknown as HTMLElement, root); }
  finally { globalThis.fetch = fetch; if (document) Object.defineProperty(globalThis, 'document', document); else Reflect.deleteProperty(globalThis, 'document'); }
}
const read = async (signal: AbortSignal) => {
  const response = await fetchStartupWithRetry('http://127.0.0.1/hold', { method: 'POST', signal });
  if (!response.ok) throw new Error('startup-unavailable');
  return response.json();
};

test('native startup reaches admission after a transient transport failure', async () => fixture(async root => {
  let calls = 0, mounted = 0;
  globalThis.fetch = async () => { if (++calls === 1) throw new TypeError('connection refused'); return Response.json(null); };
  await startGuardedApplication(root, { readHold: read, load: async () => { mounted++; } }, { admissionTimeoutMs: 1000 });
  assert.equal(calls, 2); assert.equal(mounted, 1); assert.equal(root.dataset.startupState, 'running');
}));

test('perpetual refusal is bounded by the admission deadline', async () => fixture(async root => {
  let calls = 0, mounted = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('connection refused'); };
  await startGuardedApplication(root, { readHold: read, load: async () => { mounted++; } }, { admissionTimeoutMs: 250 });
  const atDeadline = calls; await delay(250);
  assert.ok(atDeadline >= 1); assert.equal(calls, atDeadline); assert.equal(mounted, 0); assert.equal(root.dataset.startupState, 'unavailable');
}));

test('cancelling during retry delay makes no further request or mount', async () => fixture(async (root, node) => {
  let calls = 0, mounted = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('connection refused'); };
  const pending = startGuardedApplication(root, { readHold: read, load: async () => { mounted++; } });
  await delay(10); node.all().find(child => child.listeners.has('click'))!.listeners.get('click')!();
  await pending; await delay(250);
  assert.equal(calls, 1); assert.equal(mounted, 0); assert.equal(root.dataset.startupState, 'unavailable');
}));

for (const status of [401, 403, 500]) test(`HTTP ${status} fails immediately without retry`, async () => fixture(async root => {
  let calls = 0, mounted = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status }); };
  await startGuardedApplication(root, { readHold: read, load: async () => { mounted++; } });
  assert.equal(calls, 1); assert.equal(mounted, 0); assert.equal(root.dataset.startupState, 'unavailable');
}));

test('malformed JSON fails immediately without retry', async () => fixture(async root => {
  let calls = 0, mounted = 0;
  globalThis.fetch = async () => { calls++; return new Response('{'); };
  await startGuardedApplication(root, { readHold: read, load: async () => { mounted++; } });
  assert.equal(calls, 1); assert.equal(mounted, 0); assert.equal(root.dataset.startupState, 'unavailable');
}));

