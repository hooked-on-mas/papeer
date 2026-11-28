type Fonts = { readonly status: string; readonly ready: PromiseLike<unknown> };

/** One drawing's font barrier. Render facts remain owned by the caller. */
export function createPdfFontReadiness({ fonts, isCurrent, invalidate, refit, onReady }: {
  fonts: Fonts;
  isCurrent(): boolean;
  invalidate(): void;
  refit(): boolean;
  onReady(): void;
}) {
  let alive = true, ticket = 0, pending = true, resolved = false, rejected = false;
  const current = (expected: number) => alive && ticket === expected && isCurrent();
  const tryRelease = () => {
    const expected = ticket;
    if (!pending || !resolved || rejected || !current(expected) || fonts.status !== 'loaded') return false;
    let fitted = false;
    try { fitted = refit(); }
    catch { rejected = true; return false; }
    if (!fitted || !current(expected) || fonts.status !== 'loaded') return false;
    pending = false;
    return true;
  };
  const loading = () => {
    if (!alive || !isCurrent()) return;
    const expected = ++ticket;
    pending = true; resolved = false; rejected = false;
    invalidate();
    if (!current(expected)) return;
    // A loading notification can arrive after the actual set has settled.
    // Only its real ready promise, never the notification name, clears the gate.
    let ready: PromiseLike<unknown>;
    try { ready = fonts.ready; }
    catch { rejected = true; return; }
    void Promise.resolve(ready).then(() => {
      if (!current(expected)) return;
      resolved = true;
      if (tryRelease()) onReady();
    }, () => { if (current(expected)) rejected = true; });
  };
  return {
    fonts,
    get pending() { return pending; },
    loading,
    notify() {
      if (!alive || !isCurrent()) return;
      if (!pending) loading();
      else if (tryRelease()) onReady();
    },
    tryRelease,
    dispose() { alive = false; ticket++; pending = true; },
  };
}

export type PdfFontReadiness = ReturnType<typeof createPdfFontReadiness>;
