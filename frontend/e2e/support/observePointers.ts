import type { Page } from 'playwright-core';

/** Bounded observation only: no global action or product ownership. */
export async function observePointers(page: Page) {
  const handle = await page.evaluateHandle(() => {
    const events: { at: number; type: string; trusted: boolean; pointerType: string; pointerId: number; pressure: number; buttons: number; x: number; y: number; tag: string | null; role: string | null; endpoint: string | null; pane: string | null; inkLabel: string | null; reader: boolean; surface: string | null; paperPage: string | null }[] = [];
    const listener = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      events.push({ at: performance.now(), type: event.type, trusted: event.isTrusted, pointerType: event.pointerType, pointerId: event.pointerId, pressure: event.pressure, buttons: event.buttons, x: event.clientX, y: event.clientY,
        tag: target?.tagName ?? null, role: target?.getAttribute('role') ?? null, endpoint: target?.closest<HTMLElement>('[data-pdf-text-endpoint]')?.dataset.pdfTextEndpoint ?? null,
        pane: target?.closest('[data-pdf-scroller], .document-paper-pane')?.getAttribute('class') ?? null, inkLabel: target?.closest('svg')?.getAttribute('aria-label') ?? null, reader: !!target?.closest('[data-reader-root]'),
        surface: target?.closest('[data-reader-reference]') ? 'reference' : target?.closest('[data-reader-surface]')?.getAttribute('data-reader-surface') ?? null,
        paperPage: target?.closest('[data-paper-page]')?.getAttribute('data-paper-page') ?? null });
      if (events.length > 120) events.shift();
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) window.addEventListener(type, listener, true);
    return { read: () => events.slice(), stop: () => { for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) window.removeEventListener(type, listener, true); } };
  });
  return { read: () => handle.evaluate(value => value.read()), stop: async () => { await handle.evaluate(value => value.stop()); await handle.dispose(); } };
}
