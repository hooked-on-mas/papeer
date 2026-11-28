import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settlePdfPointerContact, withSynchronousTerminalContinuation, isSoleTerminalSwipeContact } from '../src/features/reader/pdf/pdfTextGesture.ts';

test('terminal continuation is synchronous, single use, and rechecks contact facts before step', () => {
  const own = { ending: false, phase: 'pan' }, inventory = new Map([[1, own]]);
  let other = false, drain = false, current = true, steps = 0;
  let late: (() => boolean | undefined) | undefined;
  settlePdfPointerContact(inventory, 1, contact => {
    const valid = () => inventory.get(1) === contact && contact.ending && contact.phase === 'pan' && !other && !drain && current;
    withSynchronousTerminalContinuation<boolean>(valid, consume => {
      late = () => consume(() => { steps++; return true; });
      assert.equal(consume(stillValid => { assert.equal(stillValid(), true); steps++; return true; }), true);
      const retry = late; assert.ok(retry); assert.equal(retry(), undefined);
    });
  });
  assert.equal(steps, 1); assert.equal(late?.(), undefined); assert.equal(inventory.size, 0);
});

test('terminal continuation rejects other contacts, drain, stale identity and changed facts before mutation', () => {
  for (const refused of ['other', 'drain', 'stale'] as const) {
    const own = { ending: false, phase: 'pan' }, inventory = new Map([[1, own]]); let steps = 0;
    settlePdfPointerContact(inventory, 1, contact => {
      const valid = () => inventory.get(1) === contact && contact.ending && contact.phase === 'pan'
        && refused !== 'other' && refused !== 'drain' && refused !== 'stale';
      withSynchronousTerminalContinuation(valid, consume => assert.equal(consume(() => { steps++; return true; }), undefined));
    });
    assert.equal(steps, 0);
  }
  let current = true, steps = 0;
  withSynchronousTerminalContinuation(() => current, consume => consume(stillValid => {
    current = false; if (stillValid()) steps++; return true;
  }));
  assert.equal(steps, 0);
});

test('sole terminal contact requires the identical admitted touch and rejects every other pane contact', () => {
  const own = { ending: true, phase: 'pan' as const, pointerType: 'touch' };
  const local = new Map([[1, own]]), panes = new Map([['main', local]]);
  assert.equal(isSoleTerminalSwipeContact(panes, 'main', 1, own), true);
  assert.equal(isSoleTerminalSwipeContact(panes, 'main', 1, { ...own }), false);
  panes.set('reference', new Map([[2, { ...own }]]));
  assert.equal(isSoleTerminalSwipeContact(panes, 'main', 1, own), false);
  panes.delete('reference'); local.set(3, { ...own });
  assert.equal(isSoleTerminalSwipeContact(panes, 'main', 1, own), false);
  local.delete(3);
  for (const value of [{ ...own, ending: false }, { ...own, phase: 'drain' as const }, { ...own, pointerType: 'pen' }]) {
    const entries = new Map([[1, value]]);
    assert.equal(isSoleTerminalSwipeContact(new Map([['main', entries]]), 'main', 1, value), false);
  }
});

test('a rejected attempt consumes the continuation even if facts later become valid', () => {
  let valid = false, steps = 0;
  withSynchronousTerminalContinuation(() => valid, consume => {
    assert.equal(consume(() => { steps++; return true; }), undefined);
    valid = true;
    assert.equal(consume(() => { steps++; return true; }), undefined);
  });
  assert.equal(steps, 0);
});

test('a wrong-root attempt consumes the continuation before a correct-root retry', () => {
  const root = {}, wrongRoot = {}; let steps = 0;
  withSynchronousTerminalContinuation(() => true, consume => {
    const attempt = (actualRoot: object) => consume(() => { steps++; return true; }, actualRoot === root);
    assert.equal(attempt(wrongRoot), undefined);
    assert.equal(attempt(root), undefined);
  });
  assert.equal(steps, 0);
});
