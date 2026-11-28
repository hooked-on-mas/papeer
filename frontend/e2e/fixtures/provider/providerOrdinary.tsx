import { createRoot } from 'react-dom/client';
import { createWebBootstrap } from '../../../src/web/bootstrapComposition.ts';
import { BootstrapConnection } from '../../../src/features/bootstrap/BootstrapConnection.tsx';

// Exact ordinary production composition and chooser. No verifier/authority/grant/seed is supplied.
const { session } = createWebBootstrap();
createRoot(document.getElementById('root')!).render(<BootstrapConnection session={session}
  renderDocument={() => <p>Document selected</p>} renderMarkdown={() => <p>Markdown selected</p>} />);
const runtime = () => { const value = session.getActiveRuntime(); if (!value) throw new Error('ordinary-runtime-not-active'); return value; };
const fixture = {
  status() { return { session: session.getSnapshot(), provider: session.getProviderConnection()?.getSnapshot(), retainedScope: session.getRetainedRuntime()?.proof.scope }; },
  async snapshot() {
    const active = session.getActiveRuntime();
    if (!active) return { phase: session.getSnapshot().phase, provider: session.getProviderConnection()?.getSnapshot(), active: null };
    await active.binding.sessions.getLibrary().refresh();
    return { phase: session.getSnapshot().phase, kind: session.getRuntimeStorageKind(), provider: session.getProviderConnection()?.getSnapshot(),
      active: { scope: active.proof.scope, library: active.binding.sessions.getLibrary().getSelectedSnapshot(),
        checkpoint: await active.binding.repository.checkpoint(), pending: await active.binding.repository.pendingRecords() } };
  },
  async createMarkdown(title: string, body: string) {
    const active = runtime(), library = active.binding.sessions.getLibrary();
    if (!await library.create({ kind: 'markdown', title })) throw new Error('ordinary-create-note-failed');
    const id = library.getSnapshot().createdId; if (!id) throw new Error('ordinary-created-id-missing');
    const markdown = active.binding.sessions.getMarkdown(id);
    if (!await markdown.refresh() || !markdown.editText(body)) throw new Error('ordinary-edit-note-failed');
    await markdown.flush(); await active.binding.replication.flush(); return id;
  },
  async editMarkdown(id: string, body: string) {
    const active = runtime(), markdown = active.binding.sessions.getMarkdown(id);
    if (!await markdown.refresh() || !markdown.editText(body)) throw new Error('ordinary-edit-note-failed');
    await markdown.flush(); await active.binding.replication.flush();
  },
  async editMarkdownNoSync(id: string, body: string) {
    const active = runtime(), markdown = active.binding.sessions.getMarkdown(id);
    if (!await markdown.refresh() || !markdown.editText(body)) throw new Error('ordinary-edit-note-failed');
    await markdown.flush();
  },
  async pauseSync() { await runtime().binding.replication.suspendAndWait(); },
  async resumeSync() { await runtime().binding.replication.resume(); },
  async sync() { await runtime().binding.replication.flush(); },
  async body(id: string) { const markdown = runtime().binding.sessions.getMarkdown(id); if (!await markdown.refresh()) throw new Error('ordinary-markdown-refresh-not-observed'); return markdown.getSnapshot().accepted; },
  async observeMarkdown(id: string, receiptId?: string) {
    const active = runtime(), markdown = active.binding.sessions.getMarkdown(id), refreshed = await markdown.refresh();
    const state = markdown.getSnapshot(), version = receiptId ?? state.accepted?.version;
    return { refreshed, state: { ready: state.ready, accepted: state.accepted, durable: state.durable, dirty: state.dirty,
      saving: state.saving, error: state.error, heads: state.heads },
      read: await active.binding.repository.read(id), receipt: version ? await active.binding.repository.receipt(version) : undefined,
      pending: await active.binding.repository.pendingRecords(), replication: active.binding.replication.getSnapshot() };
  },
  async close() { return session.close(); },
};
(window as unknown as { providerOrdinary: typeof fixture }).providerOrdinary = fixture;
export type ProviderOrdinaryFixture = typeof fixture;
