import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOfflineEnrollmentCoordinator } from '../../../../../src/adapters/browser/provider/offline/offlineEnrollmentCoordinator.ts';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('retirement aborts and drains only the matching Library and rejects new jobs', async () => {
 const owner = createOfflineEnrollmentCoordinator(), first = deferred(), entered = deferred(), retired = deferred(), other = deferred(); let signaled = false;
 const a = owner.enroll('A', new AbortController().signal, async signal => { signal.addEventListener('abort', () => { signaled = true; }); entered.resolve(); await first.promise; });
 await entered.promise; const b = owner.enroll('B', new AbortController().signal, () => other.promise);
 const retire = owner.retire('A', new AbortController().signal, async () => { retired.resolve(); return 'done'; });
 assert.equal(signaled, true); await assert.rejects(owner.enroll('A', new AbortController().signal, async () => {}), /retiring/);
 let barrierDone = false; void retired.promise.then(() => { barrierDone = true; }); await Promise.resolve(); assert.equal(barrierDone, false);
 first.resolve(); await a; assert.equal(await retire, 'done'); assert.equal(barrierDone, true);
 other.resolve(); await b; assert.equal(await owner.enroll('A', new AbortController().signal, async () => 7), 7);
});

test('failed retirement and failed enrollment release their per-Library owner', async () => {
 const owner = createOfflineEnrollmentCoordinator();
 await assert.rejects(owner.enroll('A', new AbortController().signal, async () => { throw new Error('failure'); }), /failure/);
 await assert.rejects(owner.retire('A', new AbortController().signal, async () => { throw new Error('failure'); }), /failure/);
 assert.equal(await owner.enroll('A', new AbortController().signal, async () => 9), 9);
});

test('cancelled retirement returns but retains its barrier until the old job truly settles', async () => {
 const owner = createOfflineEnrollmentCoordinator(), entered = deferred(), release = deferred(), cancellation = new AbortController(); let action = false;
 const old = owner.enroll('A', new AbortController().signal, async () => { entered.resolve(); await release.promise; });
 await entered.promise; const retiring = owner.retire('A', cancellation.signal, async () => { action = true; });
 cancellation.abort(); await assert.rejects(retiring); await assert.rejects(owner.enroll('A', new AbortController().signal, async () => {}), /retiring/);
 release.resolve(); await old; await Promise.resolve(); await Promise.resolve();
 assert.equal(action, false); assert.equal(await owner.enroll('A', new AbortController().signal, async () => 1), 1);
});

test('retirement deadline preserves the barrier for an abort-ignoring job', { timeout: 8_000 }, async () => {
 const owner = createOfflineEnrollmentCoordinator(), entered = deferred(), release = deferred(); let action = false;
 const old = owner.enroll('A', new AbortController().signal, async () => { entered.resolve(); await release.promise; });
 await entered.promise;
 await assert.rejects(owner.retire('A', new AbortController().signal, async () => { action = true; }));
 await assert.rejects(owner.enroll('A', new AbortController().signal, async () => {}), /retiring/);
 release.resolve(); await old; await Promise.resolve(); await Promise.resolve();
 assert.equal(action, false); assert.equal(await owner.enroll('A', new AbortController().signal, async () => 1), 1);
});
