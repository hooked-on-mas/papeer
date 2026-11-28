import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admission, capture, captureSynthetic, navigate, openPdfSpike, pageId, ready, selectText, snapshot } from './support/canonicalPdfSurface.ts';
import type { PdfSpikeCapture, PdfSpikeOracle, PdfSpikeSnapshot } from './support/canonicalPdfSurfaceTypes.ts';
import type { Page } from 'playwright-core';

async function pending(page: Page, count: number) {
  await page.waitForFunction(expected => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot().pendingReads === expected, count);
}
function assertMarker(result: PdfSpikeCapture, oracle: PdfSpikeOracle, physical: number) {
  assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.equal(result.quote, 'MMMM'); assert.equal(result.range.kind, 'unindexed'); assert.equal(result.quads.length, 1);
  const expected = oracle.pages.find(page => page.physicalPage === physical)!;
  const axis = expected.canonicalAxis!, band = expected.canonicalBand!, tolerance = oracle.tolerances.advancePt;
  const points = result.quads[0], x = points.map(point => point.x), y = points.map(point => point.y);
  const bounds = [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)];
  const along = Math.abs(axis[2] - axis[0]) > Math.abs(axis[3] - axis[1]) ? [bounds[0], bounds[2], axis[0], axis[2]] : [bounds[1], bounds[3], axis[1], axis[3]];
  assert.ok(Math.abs(along[0] - Math.min(along[2], along[3])) <= tolerance, `marker starts at its independently authored tick: ${JSON.stringify({ physical, bounds, axis })}`);
  assert.ok(Math.abs(along[1] - Math.max(along[2], along[3])) <= tolerance, 'marker ends at its authored tick');
  assert.ok(bounds[0] >= band[0] - 2 && bounds[1] >= band[1] - 2 && bounds[2] <= band[2] + 2 && bounds[3] <= band[3] + 2,
    'actual DOM selection region lies within the authored baseline band; no glyph-outline claim');
}
async function marker(page: Page, oracle: PdfSpikeOracle, physical: number, drawing?: PdfSpikeSnapshot, deadline?: number, preview = false) {
  const { result, selection, admission: admitted, baselineAdmission } = await captureSynthetic(page, physical, 'MMMMMMMMMM', 2, 6,
    { drawing, deadline, checkAdmission: true, expectedQuote: 'MMMM', preview });
  assertMarker(result, oracle, physical); if (preview) assert.equal(baselineAdmission, null); assert.equal(admitted, null);
  return { result, selection };
}

for (const engine of ['chromium', 'webkit'] as const) {
  test(`canonical PDF resource/Document lifetime and real Reader history (${engine})`, { timeout: 180_000 }, async t => {
    const caseDeadline = Date.now() + 180_000;
    const { scene, finish, waitWorkerHold, releaseWorkers, releaseWorkerAndWait } = await openPdfSpike(t, engine, undefined, { moduleWarmup: true, caseDeadline }), page = await scene('hold-worker');
    let heldUrl = '';
    try {
      await waitWorkerHold(page);
      await page.waitForFunction(() => {
        const value = (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot();
        return !!value.asset?.url && value.documentCallbacks === 0 && value.physicalPage === 1;
      }, undefined, { timeout: 10_000 });
      const held = await snapshot(page); heldUrl = held.asset!.url;
      assert.equal(held.documentInstances, 0); assert.equal(held.metrics.length, 0);
      assert.deepEqual(held.persisted.zoom, { kind: 'scale', value: .5 });
      await navigate(page, 2, false);
      await page.waitForFunction(() => {
        const value = (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot();
        return value.reader.pageId.endsWith('000000000002') && value.asset?.physicalPage === 2;
      });
      const moved = await snapshot(page);
      assert.equal(moved.asset?.url, heldUrl); assert.equal(moved.documentCallbacks, 0); assert.equal(moved.textReady, false);
      assert.deepEqual(moved.reader.zoom, { kind: 'scale', value: .5 });
      await releaseWorkerAndWait(page);
      await ready(page, 2);
    } finally { releaseWorkers(); }
    const original = await snapshot(page); assert.equal(original.asset?.url, heldUrl);
    assert.equal(original.reads.length, 1); assert.equal(original.documentInstances, 1); assert.equal(original.urls.length, 1);
    // This proves actual Document completion spanning a page change. It does
    // not infer which retained callback function react-pdf chose to invoke.
    for (const physical of [1, 2, 1, 150]) await navigate(page, physical);
    await page.getByRole('button', { name: 'Apply annotation-only read model', exact: true }).click(); await ready(page, 1);
    const current = await snapshot(page);
    assert.equal(current.reads.length, original.reads.length, 'page/annotation changes do not increase the observed resource reads');
    assert.equal(current.documentInstances, 1); assert.equal(current.documentCallbacks, original.documentCallbacks);
    assert.deepEqual(current.urls, original.urls);
    assert.ok(current.readyByPage[pageId(1)] >= 2 && current.readyByPage[pageId(2)] >= 1 && current.readyByPage[pageId(150)] >= 1);
    assert.ok(current.reader.back.some(location => location.pageId === pageId(2)), 'real jump records history');
    await page.getByRole('button', { name: 'Reader back', exact: true }).click(); await ready(page, 1);
    assert.equal((await snapshot(page)).reader.pageId, pageId(1));
    await page.getByRole('button', { name: 'Reader forward', exact: true }).click(); await ready(page, 1);
    await page.getByRole('button', { name: 'Flush Reader preferences', exact: true }).click();
    assert.equal((await snapshot(page)).persisted.pageId, pageId(150)); await finish();
  });

  test(`canonical PDF controlled delayed reads, old scope/hash/attempt and initial bad page (${engine})`, { timeout: 180_000 }, async t => {
    const caseDeadline = Date.now() + 180_000;
    const traceStart = performance.now();
    const trace = (stage: string) => {
      if (engine === 'webkit') process.stdout.write('[pdf-spike-stage] ' + JSON.stringify({
        engine, elapsedMs: Math.round(performance.now() - traceStart), stage,
      }) + '\n');
    };
    trace("await-01:const { scene, finish } = await openPdfSpike(t, engine, trace);:before");
    const readyCalibration = engine === 'webkit' && process.env.PDF_SPIKE_READY_CALIBRATION === '1';
    t.diagnostic(`resource ready calibration=${readyCalibration} budgetMs=${readyCalibration ? 30_000 : 25_000}`);
    const { scene, finish } = await openPdfSpike(t, engine, trace, { moduleWarmup: true, caseDeadline, readyCalibration });
    trace("await-01:const { scene, finish } = await openPdfSpike(t, engine, trace);:after");
    trace("await-02:const moved = await scene('hold-first');:before");
    const moved = await scene('hold-first');
    trace("await-02:const moved = await scene('hold-first');:after");
    trace("await-03:await pending(moved, 1);:before");
    await pending(moved, 1);
    trace("await-03:await pending(moved, 1);:after");
    trace("await-04:await navigate(moved, 2, false);:before");
    await navigate(moved, 2, false);
    trace("await-04:await navigate(moved, 2, false);:after");
    trace("await-05:await moved.getByRole('button', { name: 'Resume reads', exact: true }).click();:before");
    await moved.getByRole('button', { name: 'Resume reads', exact: true }).click();
    trace("await-05:await moved.getByRole('button', { name: 'Resume reads', exact: true }).click();:after");
    trace("await-06:await ready(moved, 2);:before");
    await ready(moved, 2);
    trace("await-06:await ready(moved, 2);:after");
    const heldScenes = [moved];
    trace("await-07:assert.equal((await snapshot(moved)).reads.length, 1);:before");
    assert.equal((await snapshot(moved)).reads.length, 1);
    trace("await-07:assert.equal((await snapshot(moved)).reads.length, 1);:after");
    trace("await-08:assert.equal((await snapshot(moved)).urls.length, 1);:before");
    assert.equal((await snapshot(moved)).urls.length, 1);
    trace("await-08:assert.equal((await snapshot(moved)).urls.length, 1);:after");
    for (const command of ['Switch scope', 'Retry resource']) {
      trace(`loop-command:${command}`);
      trace("await-09:const page = await scene('hold-first');:before");
      const page = await scene('hold-first');
      trace("await-09:const page = await scene('hold-first');:after");
      trace("await-10:await pending(page, 1);:before");
      await pending(page, 1);
      trace("await-10:await pending(page, 1);:after");
      heldScenes.push(page);
      trace("await-11:await page.getByRole('button', { name: command, exact: true }).click();:before");
      await page.getByRole('button', { name: command, exact: true }).click();
      trace("await-11:await page.getByRole('button', { name: command, exact: true }).click();:after");
      trace("await-12:await pending(page, 2);:before");
      await pending(page, 2);
      trace("await-12:await pending(page, 2);:after");
      trace("await-13:await page.getByRole('button', { name: 'Release oldest read', exact: true }).click();:before");
      await page.getByRole('button', { name: 'Release oldest read', exact: true }).click();
      trace("await-13:await page.getByRole('button', { name: 'Release oldest read', exact: true }).click();:after");
      trace("await-14:await pending(page, 1);:before");
      await pending(page, 1);
      trace("await-14:await pending(page, 1);:after");
      trace("await-15:await page.waitForFunction(() => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapsh:before");
      await page.waitForFunction(() => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot().reads[0].completed);
      trace("await-15:await page.waitForFunction(() => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapsh:after");
      trace("await-16:assert.equal((await snapshot(page)).asset, null, 'an old completion cannot publish against the curre:before");
      assert.equal((await snapshot(page)).asset, null, 'an old completion cannot publish against the current request');
      trace("await-16:assert.equal((await snapshot(page)).asset, null, 'an old completion cannot publish against the curre:after");
      trace("await-17:await page.getByRole('button', { name: 'Resume reads', exact: true }).click();:before");
      await page.getByRole('button', { name: 'Resume reads', exact: true }).click();
      trace("await-17:await page.getByRole('button', { name: 'Resume reads', exact: true }).click();:after");
      trace("await-18:await ready(page, 1);:before");
      await ready(page, 1);
      trace("await-18:await ready(page, 1);:after");
      trace("await-19:const value = await snapshot(page);:before");
      const value = await snapshot(page);
      trace("await-19:const value = await snapshot(page);:after");
      assert.equal(value.reads.length, 2);
      assert.equal(value.documentInstances, 1);
      assert.deepEqual(value.urls, [value.asset!.url], 'only the final accepted resource URL may ever appear, including after the old hash completes');
      if (command === 'Switch scope') assert.equal(value.scope, 'pdf-spike-B'); else assert.equal(value.attempt, 1);
    }
    trace("await-20:const hash = await scene('hold-first');:before");
    const hash = await scene('hold-first');
    trace("await-20:const hash = await scene('hold-first');:after");
    trace("await-21:await pending(hash, 1);:before");
    await pending(hash, 1);
    trace("await-21:await pending(hash, 1);:after");
    trace("await-22:await hash.getByRole('button', { name: 'Use stale source hash', exact: true }).click();:before");
    await hash.getByRole('button', { name: 'Use stale source hash', exact: true }).click();
    trace("await-22:await hash.getByRole('button', { name: 'Use stale source hash', exact: true }).click();:after");
    trace("await-23:await pending(hash, 2);:before");
    await pending(hash, 2);
    trace("await-23:await pending(hash, 2);:after");
    trace("await-24:await hash.getByRole('button', { name: 'Use valid source hash', exact: true }).click();:before");
    await hash.getByRole('button', { name: 'Use valid source hash', exact: true }).click();
    trace("await-24:await hash.getByRole('button', { name: 'Use valid source hash', exact: true }).click();:after");
    trace("await-25:await pending(hash, 3);:before");
    await pending(hash, 3);
    trace("await-25:await pending(hash, 3);:after");
    for (const remaining of [2, 1]) {
      trace(`release-remaining:${remaining}`);
      trace("await-26:await hash.getByRole('button', { name: 'Release oldest read', exact: true }).click();:before");
      await hash.getByRole('button', { name: 'Release oldest read', exact: true }).click();
      trace("await-26:await hash.getByRole('button', { name: 'Release oldest read', exact: true }).click();:after");
      trace("await-27:await pending(hash, remaining);:before");
      await pending(hash, remaining);
      trace("await-27:await pending(hash, remaining);:after");
      trace("await-28:assert.equal((await snapshot(hash)).asset, null);:before");
      assert.equal((await snapshot(hash)).asset, null);
      trace("await-28:assert.equal((await snapshot(hash)).asset, null);:after");
    }
    trace("await-29:await hash.getByRole('button', { name: 'Resume reads', exact: true }).click();:before");
    await hash.getByRole('button', { name: 'Resume reads', exact: true }).click();
    trace("await-29:await hash.getByRole('button', { name: 'Resume reads', exact: true }).click();:after");
    trace("await-30:await ready(hash, 1);:before");
    await ready(hash, 1);
    trace("await-30:await ready(hash, 1);:after");
    heldScenes.push(hash);
    trace("await-31:assert.equal((await snapshot(hash)).reads.length, 3);:before");
    assert.equal((await snapshot(hash)).reads.length, 3);
    trace("await-31:assert.equal((await snapshot(hash)).reads.length, 3);:after");
    trace("await-32:assert.deepEqual((await snapshot(hash)).urls, [(await snapshot(hash)).asset!.url]);:before");
    assert.deepEqual((await snapshot(hash)).urls, [(await snapshot(hash)).asset!.url]);
    trace("await-32:assert.deepEqual((await snapshot(hash)).urls, [(await snapshot(hash)).asset!.url]);:after");
    trace("await-33:const bad = await scene('bad-page');:before");
    const bad = await scene('bad-page');
    trace("await-33:const bad = await scene('bad-page');:after");
    trace("await-34:await bad.waitForFunction(() => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapsho:before");
    await bad.waitForFunction(() => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot().reads[0]?.completed);
    trace("await-34:await bad.waitForFunction(() => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapsho:after");
    trace("await-35:assert.equal((await snapshot(bad)).asset, null);:before");
    assert.equal((await snapshot(bad)).asset, null);
    trace("await-35:assert.equal((await snapshot(bad)).asset, null);:after");
    trace("await-36:await navigate(bad, 1);:before");
    await navigate(bad, 1);
    trace("await-36:await navigate(bad, 1);:after");
    trace("await-37:const recovered = await snapshot(bad);:before");
    const recovered = await snapshot(bad);
    trace("await-37:const recovered = await snapshot(bad);:after");
    assert.equal(recovered.reads.length, 1, 'bad page admission does not discard the verified resource proof');
    assert.equal(recovered.urls.length, 1); assert.equal(recovered.documentInstances, 1);

    // Also retire an already displayed proof. Initial-held reads alone cannot
    // prove old asset/text invalidation. All changes use visible real controls.
    trace("await-38:const displayed = await scene();:before");
    const displayed = await scene();
    trace("await-38:const displayed = await scene();:after");
    trace("await-39:let before = await ready(displayed, 1);:before");
    // Keep the same accepted observation rather than racing a second snapshot.
    // Every retirement below is still inspected freshly after the real click.
    let before = await ready(displayed, 1);
    trace("await-39:let before = await ready(displayed, 1);:after");
    for (const command of ['Switch scope', 'Retry resource', 'Use stale source hash']) {
      trace(`loop-command:${command}`);
      assert.ok(before.asset);
      assert.equal(before.textReady, true);
      trace("await-41:await displayed.getByRole('button', { name: 'Hold future reads', exact: true }).click();:before");
      await displayed.getByRole('button', { name: 'Hold future reads', exact: true }).click();
      trace("await-41:await displayed.getByRole('button', { name: 'Hold future reads', exact: true }).click();:after");
      trace("await-42:await displayed.getByRole('button', { name: command, exact: true }).click();:before");
      await displayed.getByRole('button', { name: command, exact: true }).click();
      trace("await-42:await displayed.getByRole('button', { name: command, exact: true }).click();:after");
      trace("await-43:await pending(displayed, 1);:before");
      await pending(displayed, 1);
      trace("await-43:await pending(displayed, 1);:after");
      trace("await-44:const retired = await snapshot(displayed);:before");
      const retired = await snapshot(displayed);
      trace("await-44:const retired = await snapshot(displayed);:after");
      assert.equal(retired.asset, null, 'the old URL is invalid before pending replacement I/O completes');
      assert.equal(retired.textReady, false, 'the old text binding is invalid in the same pending source');
      assert.equal(retired.rasterReady, false); assert.deepEqual(retired.urls, before.urls);
      if (command === 'Use stale source hash') {
        trace("await-45:await displayed.getByRole('button', { name: 'Use valid source hash', exact: true }).click();:before");
        await displayed.getByRole('button', { name: 'Use valid source hash', exact: true }).click();
        trace("await-45:await displayed.getByRole('button', { name: 'Use valid source hash', exact: true }).click();:after");
        trace("await-46:await pending(displayed, 2);:before");
        await pending(displayed, 2);
        trace("await-46:await pending(displayed, 2);:after");
        trace("await-47:await displayed.getByRole('button', { name: 'Release oldest read', exact: true }).click();:before");
        await displayed.getByRole('button', { name: 'Release oldest read', exact: true }).click();
        trace("await-47:await displayed.getByRole('button', { name: 'Release oldest read', exact: true }).click();:after");
        trace("await-48:await pending(displayed, 1);:before");
        await pending(displayed, 1);
        trace("await-48:await pending(displayed, 1);:after");
        trace("await-49:assert.equal((await snapshot(displayed)).asset, null);:before");
        assert.equal((await snapshot(displayed)).asset, null);
        trace("await-49:assert.equal((await snapshot(displayed)).asset, null);:after");
      }
      trace("await-50:await displayed.getByRole('button', { name: 'Resume reads', exact: true }).click();:before");
      await displayed.getByRole('button', { name: 'Resume reads', exact: true }).click();
      trace("await-50:await displayed.getByRole('button', { name: 'Resume reads', exact: true }).click();:after");
      trace("await-51:const accepted = await ready(displayed, 1);:before");
      const accepted = await ready(displayed, 1);
      trace("await-51:const accepted = await ready(displayed, 1);:after");
      assert.ok(accepted.asset);
      assert.notEqual(accepted.asset.url, before.asset.url);
      assert.deepEqual(accepted.urls, [...before.urls, accepted.asset.url], 'retired URL reappearance or intermediate old publication is retained and fails this history');
      assert.equal(accepted.asset.sourceHash, accepted.expectedHash); assert.equal(accepted.asset.scope, accepted.scope);
      before = accepted;
    }
    // completed is a pre-hash port event, never the acceptance oracle. Inspect
    // URL publication histories again after all accepted real renderers settle.
    for (const page of heldScenes) {
      trace('terminal-held-scene:begin');
      trace("await-53:await page.waitForFunction(() => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapsh:before");
      await page.waitForFunction(() => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapshot })
        .canonicalPdfSpikeSnapshot().reads.every(read => read.completed));
      trace("await-53:await page.waitForFunction(() => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapsh:after");
      trace("await-54:const terminal = await snapshot(page);:before");
      const terminal = await snapshot(page);
      trace("await-54:const terminal = await snapshot(page);:after");
      assert.equal(terminal.pendingReads, 0);
      assert.ok(terminal.reads.every(read => read.completed)); assert.equal(terminal.textReady, true);
      assert.deepEqual(terminal.urls, [terminal.asset!.url]);
    }
    trace("await-55:await finish();:before");
    await finish();
    trace("await-55:await finish();:after");
  });


  test(`canonical actual-PDF inspection fences persistent Reader min-fit normalization (${engine})`, { timeout: 180_000 }, async t => {
    const caseDeadline = Date.now() + 180_000;
    const { scene, finish } = await openPdfSpike(t, engine, undefined, { moduleWarmup: true, caseDeadline });
    const delayed = await scene('hold-first'); await pending(delayed, 1);
    await delayed.getByRole('button', { name: 'Flush Reader preferences', exact: true }).click();
    assert.deepEqual((await snapshot(delayed)).persisted.zoom, { kind: 'scale', value: .5 });
    assert.equal((await snapshot(delayed)).metrics.length, 0); assert.equal((await snapshot(delayed)).writes.length, 0);
    for (const scenario of ['bad-count', 'false-dimensions']) {
      const page = await scene(scenario);
      await page.getByRole('alert').filter({ hasText: 'PDFを確認できません' }).waitFor();
      // Deterministically flush any dirty preference work; do not race the
      // session's 150ms timer or hide legitimate reconciliation with a sleep.
      await page.getByRole('button', { name: 'Flush Reader preferences', exact: true }).click();
      const state = await snapshot(page);
      assert.equal(state.documentInstances, 1, 'the actual rejected Document instance was observed');
      assert.equal(state.metrics.length, 0); assert.equal(state.textReady, false);
      assert.deepEqual(state.persisted.zoom, { kind: 'scale', value: .5 }); assert.equal(state.writes.length, 0);
      assert.equal(state.persisted.surfacePageId, state.reader.surfacePageId);
      assert.equal(state.persisted.landing?.backgroundRevision, state.reader.landing.backgroundRevision);
    }
    const normal = await scene('minfit'); await ready(normal, 2);
    await normal.waitForFunction(() => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot().reader.zoom.kind === 'fit-page');
    await normal.getByRole('button', { name: 'Flush Reader preferences', exact: true }).click();
    const accepted = await snapshot(normal); assert.ok(accepted.metrics.length > 0);
    assert.deepEqual(accepted.persisted.zoom, { kind: 'fit-page' }); assert.ok(accepted.writes.length >= 1); await finish();
  });

  test(`canonical real PDF partial/multiline/marked text and CropBox quarter rotations (${engine})`, { timeout: 180_000 }, async t => {
    const { scene, oracle, finish } = await openPdfSpike(t, engine, undefined, { moduleWarmup: true }), page = await scene();
    let deadline = Date.now() + 25_000; await ready(page, 1, undefined, deadline);
    const structure = await snapshot(page);
    assert.ok(structure.textItems.some(item => item.str === '' && item.hasEOL), 'actual PDF.js empty EOL item is mandatory');
    assert.ok(structure.dom.breaks > 0 && structure.dom.marked > 0, 'actual EOL and marked-content DOM must be exercised');
    await marker(page, oracle, 1, undefined, deadline);
    const lines = (await captureSynthetic(page, 1, 'MMMMMMMMMM', 0, 'NEXT LINE'.length,
      { lastText: 'NEXT LINE', deadline: Date.now() + 25_000 })).result; assert.equal(lines.status, 'ready');
    if (lines.status === 'ready') assert.ok(lines.quads.length >= 2, 'all selected actual items contribute quads');
    for (const physical of [3, 4, 5, 6]) {
      deadline = Date.now() + 25_000; await navigate(page, physical, true, deadline);
      const selected = await marker(page, oracle, physical, undefined, deadline, true);
      const polygon = await page.locator('[data-highlight-id] polygon').boundingBox(); assert.ok(polygon);
      const rect = selected.selection.rects[0];
      assert.ok(Math.abs(polygon.x - rect.x) <= oracle.tolerances.overlayClientPx && Math.abs(polygon.y - rect.y) <= oracle.tolerances.overlayClientPx);
      assert.ok(Math.abs(polygon.width - rect.width) <= oracle.tolerances.overlayClientPx && Math.abs(polygon.height - rect.height) <= oracle.tolerances.overlayClientPx,
        'existing canonical SVG reprojects the actual selected region');
    }
    assert.equal((await snapshot(page)).documentInstances, 1); await finish();
  });

  test(`canonical representative scale/DPR and real Unicode/grapheme/ligature semantics (${engine})`, { timeout: 180_000 }, async t => {
    const { scene, oracle, finish } = await openPdfSpike(t, engine, undefined, { moduleWarmup: true });
    for (const [scale, dpr] of [[.75, 1], [1.5, 2]]) {
      const page = await scene('normal', dpr); await ready(page, 1);
      await page.getByLabel('Reader scale', { exact: true }).selectOption(String(scale));
      const deadline = Date.now() + 25_000; await ready(page, 1, undefined, deadline);
      assert.equal((await snapshot(page)).dom.dpr, dpr); assert.equal((await snapshot(page)).dom.pixelRatio, dpr);
      await marker(page, oracle, 1, undefined, deadline);
      const unicodeDeadline = Date.now() + 25_000; await navigate(page, 7, true, unicodeDeadline);
      const actual = (await snapshot(page)).textItems.map(item => item.str).join('');
      for (const text of oracle.pages[6].requiredActualText!) assert.ok(actual.includes(text), `required actual TextContent ${JSON.stringify(text)} is not optional`);
      for (const [text, start, end] of [['e\u0301', 0, 1], ['\u{20bb7}', 1, 2]] as const) {
        assert.deepEqual((await captureSynthetic(page, 7, text, start, end, { deadline: unicodeDeadline })).result,
          { status: 'refused', reason: 'unsupported-text-boundary' });
      }
      assert.equal((await captureSynthetic(page, 7, '\u{20bb7}', 0, 2, { deadline: unicodeDeadline })).result.status, 'ready');
      const whole = (await captureSynthetic(page, 7, 'fi', 0, 2, { deadline: unicodeDeadline })).result; assert.equal(whole.status, 'ready');
      const halfCapture = await captureSynthetic(page, 7, 'fi', 0, 1, { deadline: unicodeDeadline });
      const halfSelection = halfCapture.selection, half = halfCapture.result; assert.equal(half.status, 'ready');
      if (half.status === 'ready' && whole.status === 'ready') {
        assert.equal(half.quote, 'f'); assert.equal(half.range.kind, 'unindexed'); assert.equal(halfSelection.quote, 'f');
        const width = (value: { quads: { x: number }[][] }) => Math.max(...value.quads[0].map(point => point.x)) - Math.min(...value.quads[0].map(point => point.x));
        assert.ok(width(half) > 0 && width(half) <= width(whole) + .1, 'actual DOM ligature semantics, never a character-count width ratio');
      }
    }
    await finish();
  });

  test(`canonical old-token/font/DOM proof and unsupported wrapper/UserUnit refusals (${engine})`, { timeout: 180_000 }, async t => {
    const { scene, oracle, finish, releaseFontAndWait } = await openPdfSpike(t, engine, undefined, { moduleWarmup: true }), page = await scene();
    let deadline = Date.now() + 25_000; await ready(page, 1, undefined, deadline);
    await marker(page, oracle, 1, undefined, deadline); const beforeResize = await snapshot(page), fixed = beforeResize.capture;
    await page.getByRole('button', { name: 'Resize pane', exact: true }).click(); deadline = Date.now() + 25_000;
    const resized = await ready(page, 1, beforeResize, deadline);
    assert.equal(await admission(page), 'stale-render'); assert.deepEqual((await snapshot(page)).capture, fixed);
    await marker(page, oracle, 1, resized, deadline);
    await page.getByRole('button', { name: 'Start held font', exact: true }).click();
    await page.waitForFunction(() => document.fonts.status === 'loading');
    assert.equal((await snapshot(page)).fonts, 'loading'); assert.notEqual(await admission(page), null);
    await releaseFontAndWait(page); await ready(page, 1);
    assert.equal(await admission(page), 'stale-render', 'completed font load must not re-label an old capture');
    assert.deepEqual((await snapshot(page)).fontErrors, []);
    for (const [command, kind, reason] of [['Fault replace equal Text node', 'replace-node', 'stale-render'],
      ['Fault clear text layer', 'clear-layer', 'stale-render'], ['Fault skew wrapper', 'skew-wrapper', 'unsupported-transform']] as const) {
      await navigate(page, 150); deadline = Date.now() + 25_000;
      await navigate(page, 1, true, deadline);
      const captured = await captureSynthetic(page, 1, 'MMMMMMMMMM', 2, 6,
        { deadline, expectedQuote: 'MMMM', checkAdmission: true, fault: { label: command, kind } });
      assertMarker(captured.result, oracle, 1); assert.equal(captured.baselineAdmission, null); assert.equal(captured.admission, reason);
    }
    await navigate(page, 8); await selectText(page, 'MMMMMMMMMM', 2, 6);
    const actualLayout = await page.locator('.react-pdf__Page').evaluate(element => {
      const canvas = element.querySelector('canvas')!.getBoundingClientRect(), layer = element.querySelector('.textLayer')!.getBoundingClientRect();
      return { canvas: { width: canvas.width, height: canvas.height }, text: { width: layer.width, height: layer.height } };
    });
    assert.ok(Math.abs(actualLayout.canvas.width - actualLayout.text.width) > 2
      || Math.abs(actualLayout.canvas.height - actualLayout.text.height) > 2,
      'the installed renderer must exhibit an actual UserUnit layout mismatch; a future aligned renderer needs positive marker-oracle acceptance');
    assert.deepEqual(await capture(page), { status: 'refused', reason: 'layout-mismatch' });
    assert.equal((await snapshot(page)).overlays, 0); await finish();
  });
}
