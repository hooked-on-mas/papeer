import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GateOperationStale, RuntimeIoGate, type RuntimeIoGateHooks } from '../src/runtime/lifecycle/RuntimeIoGate.ts';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
type Binding = { id: string }; type Proof = { scope: string }; type Op = { binding: Binding; signal: AbortSignal };
function fixture() {
 let invalidation = () => {}, candidateGate: Promise<void> | null = null, entered = () => {}, candidateSignal: AbortSignal | null = null;
 const hooks: RuntimeIoGateHooks<Binding, Proof, Op> = { capture: (binding, _proof, signal) => ({ binding, signal }), assertCurrent: op => { if (op.signal.aborted) throw new Error('revoked'); },
  sameAdmission: (a, b) => a.scope === b.scope, validateCandidate: async (_binding, _proof, signal) => { candidateSignal = signal; entered(); if (candidateGate) await candidateGate; },
  subscribeInvalidation: fn => { invalidation = fn; return () => { invalidation = () => {}; }; } };
 const binding = { id: 'A' }, proof = { scope: 'scope' }, gate = new RuntimeIoGate(binding, proof, hooks);
 return { gate, binding, proof, candidateSignal: () => candidateSignal, invalidate: () => invalidation(), candidate: (gate: Promise<void>, onEnter: () => void) => { candidateGate = gate; entered = onEnter; } };
}
test('revoke before action blocks callback and does not infer commit status', async () => {
 const f = fixture(); let calls = 0; const result = f.gate.run(undefined, async () => { calls++; return 1; }); f.gate.revoke();
 await assert.rejects(result, (error: unknown) => error instanceof GateOperationStale && !error.started); assert.equal(calls, 0);
});
test('old result cannot be delivered or rebound during a new handoff', async () => {
 const f = fixture(), wait = deferred<number>(); let seen = '';
 const old = f.gate.run(undefined, async op => { seen = op.binding.id; return wait.promise; }); await Promise.resolve();
 f.gate.revoke(); const next = { id: 'B' }, handoff = f.gate.reauthorize(next, f.proof, new AbortController().signal);
 const observed = assert.rejects(old, (error: unknown) => error instanceof GateOperationStale && error.started);
 wait.resolve(7); await observed; await handoff; assert.equal(seen, 'A'); assert.equal(await f.gate.run(undefined, async op => op.binding.id), 'B');
});
test('acquisition cancellation is detached after handoff; sync checks bracket action', async () => {
 const f = fixture(); f.gate.revoke(); const acquisition = new AbortController(); await f.gate.reauthorize({ id: 'B' }, f.proof, acquisition.signal); acquisition.abort();
 assert.equal(f.gate.runSync(op => op.binding.id), 'B');
 assert.throws(() => f.gate.runSync(() => { f.invalidate(); return 1; }), (error: unknown) => error instanceof GateOperationStale && error.started);
});
test('close wins a delayed candidate and is terminal and idempotent', async () => {
 const f = fixture(), wait = deferred<void>(), entered = deferred<void>(); f.gate.revoke(); f.candidate(wait.promise, () => entered.resolve());
 const pending = f.gate.reauthorize({ id: 'B' }, f.proof, new AbortController().signal), observed = assert.rejects(pending, GateOperationStale); await entered.promise;
 const close = f.gate.close(); assert.equal(f.gate.close(), close); assert.equal(f.candidateSignal()?.aborted, true);
 let closed = false; void close.then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
 wait.resolve(); await observed; await close; assert.equal(closed, true);
 await assert.rejects(f.gate.reauthorize(f.binding, f.proof, new AbortController().signal), GateOperationStale);
 await assert.rejects(f.gate.run(undefined, async () => 1), GateOperationStale); assert.throws(() => f.gate.runSync(() => 1), GateOperationStale);
});
test('concurrent handoffs cannot install an obsolete candidate', async () => {
 const f = fixture(), wait = deferred<void>(), entered = deferred<void>(); f.gate.revoke(); f.candidate(wait.promise, () => entered.resolve());
 const first = f.gate.reauthorize({ id: 'B' }, f.proof, new AbortController().signal), rejected = assert.rejects(first, GateOperationStale); await entered.promise;
 const second = f.gate.reauthorize({ id: 'C' }, f.proof, new AbortController().signal); wait.resolve(); await rejected; await second;
 assert.equal(f.gate.runSync(op => op.binding.id), 'C');
});


test('replacement cancels old candidate and waits for its settlement before validation', async () => {
 const f = fixture(), oldGate = deferred<void>(), oldEntered = deferred<void>(), nextEntered = deferred<void>();
 f.gate.revoke(); f.candidate(oldGate.promise, oldEntered.resolve);
 const old = f.gate.reauthorize({ id: 'B' }, f.proof, new AbortController().signal), oldRejected = assert.rejects(old, GateOperationStale); await oldEntered.promise;
 const oldSignal = f.candidateSignal(); f.candidate(Promise.resolve(), nextEntered.resolve);
 const next = f.gate.reauthorize({ id: 'C' }, f.proof, new AbortController().signal);
 assert.equal(oldSignal?.aborted, true); let enteredNext = false; void nextEntered.promise.then(() => { enteredNext = true; });
 await Promise.resolve(); assert.equal(enteredNext, false); oldGate.resolve(); await oldRejected; await next;
 assert.equal(enteredNext, true); assert.equal(f.gate.runSync(op => op.binding.id), 'C');
});

test('explicit revoke cancels a pending candidate and leaves the gate inactive', async () => {
 const f = fixture(), wait = deferred<void>(), entered = deferred<void>(); f.gate.revoke(); f.candidate(wait.promise, entered.resolve);
 const pending = f.gate.reauthorize({ id: 'B' }, f.proof, new AbortController().signal), rejected = assert.rejects(pending, GateOperationStale); await entered.promise;
 f.gate.revoke(); assert.equal(f.candidateSignal()?.aborted, true); wait.resolve(); await rejected;
 assert.throws(() => f.gate.runSync(() => 1), GateOperationStale);
});
