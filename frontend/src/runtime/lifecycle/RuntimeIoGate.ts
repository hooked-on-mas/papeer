/** Host-specific identity, authorization and I/O stay in the hooks. */
export interface RuntimeIoGateHooks<Binding, Proof, Operation> {
 capture(binding: Binding, proof: Proof, signal: AbortSignal): Operation;
 assertCurrent(operation: Operation): void;
 sameAdmission(previous: Proof, next: Proof): boolean;
 validateCandidate(binding: Binding, proof: Proof, signal: AbortSignal): Promise<void>;
 subscribeInvalidation(listener: () => void): () => void;
}
/** This says delivery is stale, never whether native I/O committed. */
export class GateOperationStale extends Error {
 readonly started: boolean;
 constructor(started: boolean) { super('gate-operation-stale'); this.name = 'GateOperationStale'; this.started = started; }
}
export class RuntimeIoGate<Binding, Proof, Operation> {
 private binding: Binding; private proof: Proof; private readonly hooks: RuntimeIoGateHooks<Binding, Proof, Operation>;
 private epoch = 0; private ticket = 0; private active = true; private closed = false; private generation = new AbortController();
 private readonly flights = new Set<Promise<unknown>>(); private readonly handoffs = new Set<Promise<unknown>>();
 private readonly handoffControllers = new Set<AbortController>(); private closeFlight: Promise<void> | null = null; private readonly unsubscribe: () => void;
 constructor(binding: Binding, proof: Proof, hooks: RuntimeIoGateHooks<Binding, Proof, Operation>) {
  hooks.capture(binding, proof, this.generation.signal); this.binding = binding; this.proof = proof; this.hooks = hooks;
  this.unsubscribe = hooks.subscribeInvalidation(() => this.revoke());
 }
 private check(epoch: number, generation: AbortSignal, operation: Operation, started: boolean): void {
  if (this.closed || !this.active || this.epoch !== epoch || generation.aborted || generation !== this.generation.signal) throw new GateOperationStale(started);
  try { this.hooks.assertCurrent(operation); } catch { throw new GateOperationStale(started); }
 }
 revoke(): void { this.ticket++; this.epoch++; for (const controller of this.handoffControllers) controller.abort(); if (this.active) { this.active = false; this.generation.abort(); } }
 run<T>(signal: AbortSignal | undefined, action: (operation: Operation) => Promise<T>): Promise<T> {
  if (this.closed || !this.active || signal?.aborted) return Promise.reject(new GateOperationStale(false));
  const epoch = this.epoch, generation = this.generation.signal, controller = new AbortController();
  const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true }); generation.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted || generation.aborted) cancel(); let operation: Operation;
  try { operation = this.hooks.capture(this.binding, this.proof, controller.signal); }
  catch (error) { signal?.removeEventListener('abort', cancel); generation.removeEventListener('abort', cancel); return Promise.reject(error); }
  let started = false;
  const flight = Promise.resolve().then(() => { this.check(epoch, generation, operation, false); if (controller.signal.aborted) throw new GateOperationStale(false); started = true; return action(operation); })
   .then(value => { this.check(epoch, generation, operation, true); if (controller.signal.aborted) throw new GateOperationStale(true); return value; }, error => {
    this.check(epoch, generation, operation, started); if (controller.signal.aborted) throw new GateOperationStale(started); throw error;
   }).finally(() => { signal?.removeEventListener('abort', cancel); generation.removeEventListener('abort', cancel); this.flights.delete(flight); });
  this.flights.add(flight); return flight;
 }
 runSync<T>(action: (operation: Operation) => T): T {
  if (this.closed || !this.active) throw new GateOperationStale(false);
  const epoch = this.epoch, generation = this.generation.signal, operation = this.hooks.capture(this.binding, this.proof, generation);
  this.check(epoch, generation, operation, false);
  let value: T; try { value = action(operation); } catch (error) { this.check(epoch, generation, operation, true); throw error; }
  this.check(epoch, generation, operation, true); return value;
 }
 reauthorize(binding: Binding, proof: Proof, acquisitionSignal: AbortSignal): Promise<void> {
  if (this.closed) return Promise.reject(new GateOperationStale(false));
  if (!this.hooks.sameAdmission(this.proof, proof)) return Promise.reject(new Error('host-admission-changed'));
  this.revoke(); const ticket = this.ticket;
  const oldWork = [...this.flights, ...this.handoffs];
  const candidate = new AbortController(), cancel = () => candidate.abort();
  this.handoffControllers.add(candidate); acquisitionSignal.addEventListener('abort', cancel, { once: true });
  if (acquisitionSignal.aborted) cancel();
  const current = () => !this.closed && ticket === this.ticket && !candidate.signal.aborted;
  const handoff = (async () => {
   await Promise.allSettled(oldWork); if (!current()) throw new GateOperationStale(false);
   try { await this.hooks.validateCandidate(binding, proof, candidate.signal); } catch (error) { if (!current()) throw new GateOperationStale(false); throw error; }
   if (!current()) throw new GateOperationStale(false);
   // Acquisition cancellation is detached at settlement, never used as the admitted lifetime.
   const generation = new AbortController(); this.hooks.capture(binding, proof, generation.signal);
   if (!current()) { generation.abort(); throw new GateOperationStale(false); }
   this.binding = binding; this.proof = proof; this.generation = generation; this.epoch++; this.active = true;
  })().finally(() => { acquisitionSignal.removeEventListener('abort', cancel); this.handoffControllers.delete(candidate); this.handoffs.delete(handoff); });
  this.handoffs.add(handoff); return handoff;
 }
 close(): Promise<void> {
  if (this.closeFlight) return this.closeFlight; this.closed = true; this.revoke();
  this.closeFlight = Promise.allSettled([...this.flights, ...this.handoffs]).then(() => { this.unsubscribe(); }); return this.closeFlight;
 }
}
