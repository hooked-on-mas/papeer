import type { Page } from 'playwright-core';

/** Temporary failure-only observation; no action or promise is replaced. */
export async function installNativeGateObservation(page: Page): Promise<void> {
  if (process.env.PAPEER_NATIVE_GATE_DIAGNOSTICS !== '1') return;
  await page.evaluate(async () => {
    const modulePath = '/src/runtime/lifecycle/RuntimeIoGate.ts';
    const mod = await import(/* @vite-ignore */ modulePath);
    const proto = mod.RuntimeIoGate.prototype as Record<string, (...args: unknown[]) => unknown>;
    const root = window as unknown as { __nativeGateDiagnostic?: unknown; __nativeGateInstalled?: boolean };
    if (root.__nativeGateInstalled) return;
    root.__nativeGateInstalled = true;
    const ids = new WeakMap<object, number>(); let next = 0;
    const entries: unknown[] = [];
    const stack = (error: unknown) => String((error as { stack?: unknown })?.stack ?? '').split('\n').slice(0, 6)
      .map(line => line.replace(/https?:\/\/[^/\s]+/g, '[origin]').replace(/\?.*?(?=:\d+:\d+|$)/g, '').replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, '[id]').replace(/Bearer\s+[^\s]+/gi, '[credential]').slice(0, 180)).join('\n').slice(0, 800);
    const record = (gate: object, phase: string, error?: unknown) => {
      const state = gate as { active?: boolean; closed?: boolean; epoch?: number; ticket?: number };
      let id = ids.get(gate); if (!id) { id = ++next; ids.set(gate, id); }
      entries.push({ id, phase, clockEpochMs: Date.now(), active: !!state.active, closed: !!state.closed, epoch: state.epoch, ticket: state.ticket,
        ...(error ? { stack: stack(error) } : {}) });
      if (entries.length > 100) entries.shift();
    };
    root.__nativeGateDiagnostic = () => entries.slice();
    for (const name of ['revoke', 'reauthorize', 'close'] as const) {
      const original = proto[name];
      proto[name] = function (this: object, ...args: unknown[]) { record(this, name, name === 'revoke' ? new Error() : undefined); return original.apply(this, args); };
    }
    const run = proto.run;
    proto.run = function (this: object, ...args: unknown[]) {
      const state = this as { active?: boolean; closed?: boolean };
      if (state.closed || !state.active || (args[0] as AbortSignal | undefined)?.aborted) record(this, 'run-early-reject', new Error());
      return run.apply(this, args);
    };
    const check = proto.check;
    proto.check = function (this: object, ...args: unknown[]) {
      try { return check.apply(this, args); }
      catch (error) { if (error instanceof mod.GateOperationStale) record(this, 'check-stale', error); throw error; }
    };
  });
}

export async function readNativeGateObservation(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { __nativeGateDiagnostic?: () => unknown }).__nativeGateDiagnostic?.() ?? null);
}
