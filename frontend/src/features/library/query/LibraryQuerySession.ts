import type { LibraryItem } from '../../../runtime/edits/contracts.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import type { EditScope } from '../../../runtime/edits/ports.ts';

export type LibraryQuery = {
  text: string; scope: 'metadata' | 'content' | 'all'; tag: string;
  read: 'all' | 'read' | 'unread'; sort: 'position' | 'title' | 'year' | 'author'; descending: boolean;
};
export interface LibraryQueryPreferencePort { readonly scope: EditScope; read(): unknown; write(value: LibraryQuery): void }
export type LibraryCorpusEntry = { itemId: string; text: string; status: 'complete' | 'partial' | 'missing' | 'unsupported' };
/** Read-only, scoped acquisition. Matching, filtering and ordering never belong to a host adapter. */
export interface LibraryCorpusPort {
  read(items: readonly LibraryItem[], signal: AbortSignal): Promise<readonly LibraryCorpusEntry[]>;
  /** Content heads and resource availability; cheap enough for a catalog poll, without PDF extraction. */
  revision?(items: readonly LibraryItem[], signal: AbortSignal): Promise<string>;
}
export type LibraryQueryState = {
  query: Readonly<LibraryQuery>; flat: boolean; loading: boolean;
  ids: readonly string[]; missingIds: readonly string[]; partialIds: readonly string[]; unsupportedIds: readonly string[]; error: string;
  preferenceError: string; preferenceBlocked: boolean; preferencePending: boolean;
};
const defaults = (): LibraryQuery => ({ text: '', scope: 'metadata', tag: '', read: 'all', sort: 'position', descending: false });
/** Reject malformed saved state rather than silently broadening a search. */
export function decodeLibraryQuery(raw: unknown): LibraryQuery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('library-query-invalid');
  const value = raw as Record<string, unknown>;
  const keys = ['text', 'scope', 'tag', 'read', 'sort', 'descending'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || typeof value.text !== 'string' || value.text.length > 1000 || typeof value.tag !== 'string' || Array.from(value.tag).length > 200
    || typeof value.scope !== 'string' || !['metadata', 'content', 'all'].includes(value.scope)
    || typeof value.read !== 'string' || !['all', 'read', 'unread'].includes(value.read)
    || typeof value.sort !== 'string' || !['position', 'title', 'year', 'author'].includes(value.sort)
    || typeof value.descending !== 'boolean') throw new Error('library-query-invalid');
  return { text: value.text, scope: value.scope as LibraryQuery['scope'], tag: value.tag, read: value.read as LibraryQuery['read'],
    sort: value.sort as LibraryQuery['sort'], descending: value.descending };
}
export const normalizeLibraryText = (text: string) => text.normalize('NFKC').toLowerCase();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const metadataText = (item: LibraryItem) => [item.title, ...item.tags, ...Object.values(item.metadata)].join('\n');

/** Owned by LibrarySession, separate from its durable catalog writer and Undo history. */
export class LibraryQuerySession {
  private corpus?: LibraryCorpusPort;
  private readonly active: () => boolean;
  private items: readonly LibraryItem[] = [];
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private abort?: AbortController;
  private corpusRevision?: string;
  private readonly preferences?: LibraryQueryPreferencePort;
  private readonly expectedScope?: EditScope;
  private state: LibraryQueryState = Object.freeze({ query: Object.freeze(defaults()), flat: false, loading: false,
    ids: Object.freeze([]), missingIds: Object.freeze([]), partialIds: Object.freeze([]), unsupportedIds: Object.freeze([]), error: '',
    preferenceError: '', preferenceBlocked: false, preferencePending: false });
  constructor(corpus?: LibraryCorpusPort, active: () => boolean = () => true, preferences?: LibraryQueryPreferencePort, expectedScope?: EditScope) {
    this.corpus = corpus; this.active = active; this.preferences = preferences; this.expectedScope = expectedScope && structuredClone(expectedScope);
    if (preferences) {
      try { this.assertPreferenceScope(); const raw = preferences.read(); if (raw !== null && raw !== undefined) this.update({ query: Object.freeze(decodeLibraryQuery(raw)) }); }
      catch (error) { this.update({ preferenceError: String(error), preferenceBlocked: true, flat: true }); }
    }
  }
  private assertPreferenceScope() {
    if (!this.preferences || !this.expectedScope || canonicalJson(this.preferences.scope) !== canonicalJson(this.expectedScope)) throw new Error('library-query-scope');
  }
  private savePreference(query: LibraryQuery) {
    if (!this.preferences) return;
    try { this.assertPreferenceScope(); if (!this.active()) throw new Error('library-query-inactive'); this.preferences.write(structuredClone(query));
      this.update({ preferenceError: '', preferencePending: false }); }
    catch (error) { this.update({ preferenceError: String(error), preferencePending: true }); }
  }
  retryPreference = async () => {
    if (!this.preferences || !this.active()) return;
    if (this.state.preferencePending) { this.savePreference(this.state.query); return; }
    try { this.assertPreferenceScope(); const raw = this.preferences.read(); const query = raw === null || raw === undefined ? defaults() : decodeLibraryQuery(raw);
      this.update({ query: Object.freeze(query), preferenceError: '', preferenceBlocked: false }); await this.run(); }
    catch (error) { this.generation++; this.abort?.abort(); this.update({ preferenceError: String(error), preferenceBlocked: true, flat: true,
      loading: false, ids: Object.freeze([]), missingIds: Object.freeze([]), partialIds: Object.freeze([]), unsupportedIds: Object.freeze([]) }); }
  };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<LibraryQueryState>) {
    this.state = Object.freeze({ ...this.state, ...fields }); this.listeners.forEach(listener => listener());
  }
  setCatalog(items: readonly LibraryItem[]) {
    if (canonicalJson(items) === canonicalJson(this.items)) return this.refreshCorpus();
    this.items = structuredClone(items); return this.run();
  }
  setCorpus(corpus: LibraryCorpusPort) { if (corpus === this.corpus) return; this.corpus = corpus; void this.run(); }
  cancel() { this.generation++; this.abort?.abort(); this.update({ loading: false }); }
  setQuery = (change: Partial<LibraryQuery>) => {
    if (!this.active()) return Promise.resolve();
    if (this.preferences) { try { this.assertPreferenceScope(); } catch (error) { this.generation++; this.abort?.abort(); this.update({ preferenceError: String(error), preferenceBlocked: true, flat: true, loading: false, ids: Object.freeze([]) }); return Promise.resolve(); } }
    const query = Object.freeze(decodeLibraryQuery({ ...this.state.query, ...change }));
    if (!this.state.preferenceBlocked && Object.keys(query).every(key => query[key as keyof LibraryQuery] === this.state.query[key as keyof LibraryQuery])) return Promise.resolve();
    this.update({ query, preferenceBlocked: false }); this.savePreference(query); return this.run();
  };
  clear = () => this.setQuery(defaults());
  retry = () => this.run();
  /** Revealing clears display conditions only; it does not navigate or mutate the catalog. */
  reveal = (id: string) => this.items.some(item => item.id === id) ? this.clear() : Promise.resolve();
  private async refreshCorpus() {
    const query = this.state.query;
    if (this.state.preferenceBlocked || !query.text.trim() || query.scope === 'metadata' || !this.active()) return;
    if (!this.abort || this.abort.signal.aborted || this.corpusRevision === undefined && !this.state.loading) { await this.run(); return; }
    if (!this.corpus?.revision) { if (!this.state.loading) await this.run(); return; }
    const generation = this.generation, signal = this.abort?.signal ?? new AbortController().signal;
    try {
      const items = this.filteredItems(query), revision = await this.corpus.revision(items, signal);
      if (generation !== this.generation || signal.aborted || !this.active()) return;
      // A poll must not restart the initial revision read or an unchanged, slow PDF extraction.
      if (this.corpusRevision !== undefined && revision !== this.corpusRevision) await this.run();
    } catch { /* The running scan reports acquisition failures; a later poll retries revision acquisition. */ }
  }
  private filteredItems(query: Readonly<LibraryQuery>) {
    return this.items.filter(item => (!query.tag || item.tags.includes(query.tag))
      && (query.read === 'all' || item.read === (query.read === 'read')));
  }
  private async run() {
    const generation = ++this.generation; this.abort?.abort();
    if (this.state.preferenceBlocked) {
      this.update({ flat: true, loading: false, ids: Object.freeze([]), missingIds: Object.freeze([]), partialIds: Object.freeze([]), unsupportedIds: Object.freeze([]) });
      return;
    }
    this.corpusRevision = undefined;
    const controller = new AbortController(); this.abort = controller;
    const query = this.state.query, tokens = normalizeLibraryText(query.text).split(/\s+/u).filter(Boolean);
    const items = this.filteredItems(query);
    const content = tokens.length > 0 && query.scope !== 'metadata';
    const flat = tokens.length > 0 || !!query.tag || query.read !== 'all' || query.sort !== 'position' || query.descending;
    // Remove old results immediately, including when an old port ignores cancellation.
    this.update({ flat, loading: content, ids: Object.freeze([]), missingIds: Object.freeze([]), partialIds: Object.freeze([]), unsupportedIds: Object.freeze([]), error: '' });
    let entries: readonly LibraryCorpusEntry[] = [], error = '';
    if (content) {
      if (!this.active()) { this.update({ loading: false }); return; }
      try {
        const revision = this.corpus?.revision ? await this.corpus.revision(items, controller.signal) : undefined;
        if (generation !== this.generation || controller.signal.aborted || !this.active()) return;
        this.corpusRevision = revision;
        entries = await this.corpus?.read(structuredClone(items), controller.signal) ?? [];
      }
      catch (cause) { error = String(cause); }
    }
    if (generation !== this.generation || controller.signal.aborted || content && !this.active()) return;
    const byId = new Map(entries.map(entry => [entry.itemId, entry]));
    const matches = items.filter(item => {
      const haystack = normalizeLibraryText([
        query.scope !== 'content' ? metadataText(item) : '', query.scope !== 'metadata' ? byId.get(item.id)?.text ?? '' : '',
      ].join('\n'));
      return tokens.every(token => haystack.includes(token));
    });
    matches.sort((a, b) => {
      const order = query.sort === 'title' ? compare(normalizeLibraryText(a.title), normalizeLibraryText(b.title))
        : query.sort === 'year' || query.sort === 'author' ? compare(normalizeLibraryText(a.metadata[query.sort] ?? ''), normalizeLibraryText(b.metadata[query.sort] ?? '')) : a.position - b.position;
      return (query.descending ? -order : order) || compare(a.id, b.id);
    });
    const idsWith = (status: LibraryCorpusEntry['status']) => Object.freeze(content ? items.filter(item =>
      (byId.get(item.id)?.status ?? 'missing') === status).map(item => item.id) : []);
    this.update({ loading: false, ids: Object.freeze(matches.map(item => item.id)),
      missingIds: idsWith('missing'), partialIds: idsWith('partial'), unsupportedIds: idsWith('unsupported'), error });
  }
}
