import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPdfFontReadiness } from '../../../src/features/reader/pdf/pdfFontReadiness.ts';

function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture() {
  let ready = deferred(), reads = 0, epoch = 0, refits = 0, publications = 0, width = 40;
  const tuple = { scope: 'A', source: 'hash', page: 'P1', url: 'blob:1', width: 600, dpr: 1, mounted: true };
  let active = tuple;
  const facts = { document: true, page: true, text: true, canvas: true, render: true, settled: true };
  let published: { epoch: number; scale: number } | null = null;
  let scale = 0, throwRefit = false;
  let duringRefit = () => {};
  const fonts = { status: 'loaded',
    // Such unrelated entries must never become an added document-wide ban.
    faces: [{ status: 'unloaded' }, { status: 'error' }],
    get ready() { reads++; return ready.promise; } };
  const gate = createPdfFontReadiness({ fonts, isCurrent: () => active === tuple,
    invalidate: () => { epoch++; published = null; },
    refit: () => {
      if (!Object.values(facts).every(Boolean)) return false;
      if (throwRefit) throw new Error('detached-during-layout');
      refits++; scale = 100 / width; duringRefit(); return true;
    },
    onReady: () => { publications++; published = { epoch, scale }; },
  });
  return { fonts, gate, facts, tuple,
    ready: () => ready, next: () => { ready = deferred(); return ready; },
    observe: () => ({ reads, epoch, refits, publications, published, scale }),
    arrive: () => { if (gate.tryRelease()) { publications++; published = { epoch, scale }; } },
    change: (field: keyof typeof tuple) => { active = { ...tuple, [field]: 'retired' }; },
    duringRefit: (action: () => void) => { duringRefit = action; },
    setWidth: (value: number) => { width = value; }, failRefit: (value: boolean) => { throwRefit = value; },
  };
}

test('already-loaded loading without a done event waits for actual ready before refit and publication', async () => {
  const value = fixture(); value.gate.loading();
  assert.equal(value.gate.pending, true); assert.equal(value.observe().published, null);
  value.arrive(); value.arrive(); assert.equal(value.observe().reads, 1);
  assert.equal(value.observe().refits, 0);
  value.ready().resolve(); await tick();
  assert.equal(value.gate.pending, false); assert.equal(value.observe().refits, 1);
  assert.deepEqual(value.observe().published, { epoch: 1, scale: 2.5 });
});

test('true pending fonts accept every render-fact arrival but cannot publish early', async () => {
  const value = fixture(); value.fonts.status = 'loading';
  for (const key of Object.keys(value.facts) as (keyof typeof value.facts)[]) value.facts[key] = false;
  value.gate.loading();
  for (const key of Object.keys(value.facts) as (keyof typeof value.facts)[]) {
    value.facts[key] = true; value.arrive();
    assert.equal(value.gate.pending, true); assert.equal(value.observe().published, null);
  }
  value.gate.notify(); assert.equal(value.observe().reads, 1);
  value.fonts.status = 'loaded'; value.ready().resolve(); await tick();
  assert.equal(value.observe().publications, 1);
});

test('settled ready with incomplete facts keeps the gate; later arrivals retry without resubscribing', async () => {
  const value = fixture(); value.facts.canvas = false; value.facts.render = false; value.facts.text = false;
  value.gate.loading(); value.ready().resolve(); await tick();
  assert.equal(value.gate.pending, true);
  value.facts.text = true; value.arrive(); assert.equal(value.gate.pending, true);
  value.facts.render = true; value.arrive(); assert.equal(value.gate.pending, true);
  for (let index = 0; index < 10; index++) value.arrive();
  assert.equal(value.observe().reads, 1); assert.equal(value.observe().refits, 0);
  value.facts.canvas = true; value.arrive();
  assert.equal(value.gate.pending, false); assert.equal(value.observe().publications, 1);
});

test('done/error in either order and repeated notifications cannot substitute for actual ready', async () => {
  for (const names of [['done', 'error', 'done'], ['error', 'done', 'error']]) {
    const value = fixture(); value.gate.loading();
    for (const _name of names) value.gate.notify();
    assert.equal(value.observe().reads, 1); assert.equal(value.gate.pending, true);
    assert.equal(value.observe().refits, 0);
    value.ready().resolve(); await tick();
    assert.equal(value.observe().publications, 1);
    value.gate.notify();
    assert.equal(value.gate.pending, true); assert.equal(value.observe().published, null);
    await tick(); assert.equal(value.observe().publications, 2);
  }
});

test('a rejected ready promise never publishes; a later actual cycle can recover', async () => {
  const value = fixture(); value.gate.loading(); value.ready().reject(new Error('font-set-rejected')); await tick();
  value.gate.notify(); value.arrive();
  assert.equal(value.gate.pending, true); assert.equal(value.observe().publications, 0); assert.equal(value.observe().reads, 1);
  const next = value.next(); value.gate.loading(); next.resolve(); await tick();
  assert.equal(value.gate.pending, false); assert.equal(value.observe().publications, 1);
});

test('an older ready promise cannot release the next font cycle', async () => {
  const value = fixture(); value.gate.loading(); const old = value.ready();
  const current = value.next(); value.gate.loading(); old.resolve(); await tick();
  assert.equal(value.gate.pending, true); assert.equal(value.observe().publications, 0);
  current.resolve(); await tick(); assert.equal(value.observe().publications, 1);
});

test('scope/source/page/URL/width/DPR/unmount retirement fences old settlements', async () => {
  for (const field of ['scope', 'source', 'page', 'url', 'width', 'dpr', 'mounted'] as const) {
    const value = fixture(); value.gate.loading(); value.change(field); value.ready().resolve(); await tick(); value.arrive();
    assert.equal(value.observe().refits, 0, field); assert.equal(value.observe().publications, 0, field);
  }
  const value = fixture(); value.gate.loading(); value.gate.dispose(); value.ready().resolve(); await tick(); value.gate.notify();
  assert.equal(value.observe().publications, 0); assert.equal(value.observe().refits, 0);
});

test('a refit that loses its drawing or starts a new font cycle cannot release the old gate', async () => {
  const retired = fixture(); retired.duringRefit(() => retired.change('page'));
  retired.gate.loading(); retired.ready().resolve(); await tick();
  assert.equal(retired.gate.pending, true); assert.equal(retired.observe().publications, 0);
  const cycle = fixture(); let next: ReturnType<typeof deferred> | null = null;
  cycle.duringRefit(() => { cycle.duringRefit(() => {}); next = cycle.next(); cycle.gate.loading(); });
  cycle.gate.loading(); cycle.ready().resolve(); await tick();
  assert.equal(cycle.gate.pending, true); assert.equal(cycle.observe().publications, 0);
  assert.ok(next); (next as ReturnType<typeof deferred>).resolve(); await tick();
  assert.equal(cycle.observe().publications, 1);
});

test('font settlement refits using the new measured width and cannot restore an old capture epoch', async () => {
  const value = fixture(); value.gate.loading(); value.ready().resolve(); await tick();
  const old = value.observe().published!; assert.equal(old.scale, 2.5);
  value.setWidth(80); const next = value.next(); value.gate.loading();
  assert.notEqual(value.observe().epoch, old.epoch); assert.equal(value.gate.pending, true);
  value.arrive(); assert.equal(value.observe().published, null);
  next.resolve(); await tick();
  assert.equal(value.observe().published?.scale, 1.25); assert.notEqual(value.observe().published?.epoch, old.epoch);
});

test('unrelated failed or unused faces are not a new blanket refusal policy', async () => {
  const value = fixture(); assert.deepEqual(value.fonts.faces.map(face => face.status), ['unloaded', 'error']);
  value.gate.loading(); value.ready().resolve(); await tick();
  assert.equal(value.gate.pending, false); assert.equal(value.observe().publications, 1);
});

test('DOM refit failure stays pending and never becomes an unhandled promise rejection', async () => {
  const value = fixture(); value.failRefit(true); value.gate.loading(); value.ready().resolve(); await tick();
  assert.equal(value.gate.pending, true); assert.equal(value.observe().publications, 0);
  value.failRefit(false); value.gate.notify(); value.arrive(); assert.equal(value.observe().publications, 0);
  const next = value.next(); value.gate.loading(); next.resolve(); await tick();
  assert.equal(value.observe().publications, 1);
});
