import { createCanonicalAnnotationCorpus, type AnnotationCorpusPort } from '../../src/features/library/annotations/canonicalAnnotationCorpus.ts';
import { AnnotationBrowserSession } from '../../src/features/library/annotations/AnnotationBrowserSession.ts';
import type { LibrarySnapshot } from '../../src/runtime/edits/contracts.ts';
import type { ContentRepository, EditScope, RepositoryState } from '../../src/runtime/edits/ports.ts';

// Standalone observation only; this fixture is never loaded by the application or acceptance suites.
const parameters = new URLSearchParams(location.search), mode = parameters.get('mode')!;
const attempt = parameters.get('attempt')!;
let sequence = 0;
const emit = (event: string, detail: unknown = {}) => console.log('corpus-navigation:' + JSON.stringify({
  sequence: ++sequence, at: performance.now(), timeOrigin: performance.timeOrigin, mode, attempt, event, detail,
}));
const promiseIds = new WeakMap<Promise<unknown>, number>(); let promiseSequence = 0;
const promiseId = (promise: Promise<unknown>) => {
  let id = promiseIds.get(promise); if (!id) { id = ++promiseSequence; promiseIds.set(promise, id); } return id;
};
window.addEventListener('error', event => emit('window.error', { message: event.message, stack: event.error?.stack }));
window.addEventListener('unhandledrejection', event => emit('unhandledrejection', {
  promiseId: promiseId(event.promise), reason: String(event.reason), stack: event.reason?.stack,
}));
window.addEventListener('rejectionhandled', event => emit('rejectionhandled', { promiseId: promiseId(event.promise) }));
for (const name of ['beforeunload', 'pagehide', 'pageshow'] as const)
  window.addEventListener(name, event => emit(name, { persisted: 'persisted' in event ? event.persisted : undefined }));

const config = await (await fetch('/corpus-diagnostic/config')).json() as { scope: EditScope; catalog: LibrarySnapshot };
let requestSequence = 0, available = true;
const reads = new AbortController();
const repository: Pick<ContentRepository, 'scope' | 'read'> = {
  scope: config.scope,
  async read(targetId) {
    const requestId = `${mode}:${attempt}:${++requestSequence}`;
    emit('request.start', { requestId, targetId, aborted: reads.signal.aborted });
    try {
      // The current mode deliberately matches documentComposition's fetch without a signal.
      const response = await fetch('/api/edits/read', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, targetId, mode }),
        ...(mode === 'pagehide-abort' || mode === 'pre-navigation-cancel' ? { signal: reads.signal } : {}) });
      if (!response.ok) throw new Error(`diagnostic-http-${response.status}`);
      const result = await response.json() as RepositoryState;
      emit('request.resolved', { requestId }); return result;
    } catch (cause) {
      emit('request.caught-rethrow', { requestId, reason: String(cause), stack: cause instanceof Error ? cause.stack : undefined });
      throw cause;
    }
  },
};
const original = createCanonicalAnnotationCorpus(repository);
const corpus: AnnotationCorpusPort = { async read(items, signal) {
  emit('corpus.start', { ids: items.map(item => item.id), aborted: signal.aborted });
  try {
    const result = await original.read(items, signal);
    emit('corpus.resolved', { entries: result.map(entry => ({ id: entry.documentId, status: entry.status, error: entry.error })) });
    return result;
  } catch (cause) { emit('corpus.caught-rethrow', { reason: String(cause), aborted: signal.aborted }); throw cause; }
} };
const session = new AnnotationBrowserSession({ repository, corpus, isActive: () => available });
session.subscribe(() => {
  const state = session.getSnapshot();
  emit('session.state', { loading: state.loading, error: state.error, missingIds: state.missingIds });
});
const cancel = (source: string) => {
  emit('cancel.start', { source }); available = false;
  if (mode === 'pagehide-abort' || mode === 'pre-navigation-cancel') reads.abort();
  session.setAvailable(false); emit('cancel.completed', { source });
};
window.addEventListener('pagehide', () => cancel('pagehide'));
Object.assign(window, {
  corpusDiagnosticReady: true,
  corpusDiagnosticCancel: () => cancel('controlled-before-navigation'),
  corpusDiagnosticState: () => session.getSnapshot(),
  corpusDiagnosticStart: () => {
    emit('start');
    if (mode === 'unhandled-control') { void Promise.reject(new Error('corpus-diagnostic-intentional-unhandled')); return; }
    if (mode === 'late-handled-control') {
      const pending = Promise.reject(new Error('corpus-diagnostic-intentional-late-handler'));
      setTimeout(() => { void pending.catch(() => emit('control.late-catch')); }, 60); return;
    }
    // Keep the production ownership: no observer attaches a catch/then to this returned session promise.
    void session.setCatalog(config.catalog, config.catalog.items[0].id);
  },
});
emit('ready');
