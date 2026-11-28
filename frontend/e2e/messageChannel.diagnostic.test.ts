import assert from 'node:assert/strict';
import test from 'node:test';
import { webkit } from 'playwright-core';

test('WebKit scheduler MessageChannel lifetime diagnostic', { timeout: 90_000 }, async t => {
  const browser = await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('about:blank');
  const samples: unknown[] = [];
  for (const retained of [false, true]) for (let iteration = 0; iteration < 12; iteration++) {
    await page.evaluate(retained => {
      type Probe = { delivered: number; post(): void; weak: { deref(): MessagePort | undefined }; channel?: MessageChannel };
      const global = window as unknown as { probe: Probe };
      // Match the installed React scheduler: only port2 is captured by the
      // scheduled callback; port1 has its ordinary onmessage handler.
      var channel = new MessageChannel(), port = channel.port2;
      channel.port1.onmessage = () => { global.probe.delivered++; };
      const WeakPort = (window as unknown as { WeakRef: new (port: MessagePort) => { deref(): MessagePort | undefined } }).WeakRef;
      global.probe = { delivered: 0, post: () => port.postMessage(null), weak: new WeakPort(channel.port1) };
      if (retained) global.probe.channel = channel;
    }, retained);
    await page.requestGC();
    await page.evaluate(() => (window as unknown as { probe: { post(): void } }).probe.post());
    let delivered = true;
    try { await page.waitForFunction(() => (window as unknown as { probe: { delivered: number } }).probe.delivered === 1, undefined, { timeout: 2000 }); }
    catch { delivered = false; }
    samples.push({ retained, iteration, delivered, portAlive: await page.evaluate(() => !!(window as unknown as {
      probe: { weak: { deref(): MessagePort | undefined } };
    }).probe.weak.deref()) });
  }
  t.diagnostic(JSON.stringify(samples));
  assert.ok(samples.every(value => (value as { delivered: boolean }).delivered), 'every real channel post must be delivered after GC');
});
