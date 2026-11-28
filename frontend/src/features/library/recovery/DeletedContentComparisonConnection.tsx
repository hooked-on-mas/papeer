import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { assertLibraryScopeBinding, type LibraryScopeBinding } from '../../reader/DocumentLibraryBinding';
import { DeletedContentComparisonSession } from './DeletedContentComparisonSession';
import { DeletedContentComparisonPanel } from './DeletedContentComparisonPanel';

export type DeletedContentComparisonRequest = { deletionId: string; itemId: string };
export function DeletedContentComparisonConnection({ binding, request, canRestore, close }: {
  binding: LibraryScopeBinding; request: DeletedContentComparisonRequest | null; canRestore: boolean; close(): void;
}) {
  assertLibraryScopeBinding(binding);
  const scope = binding.repository.scope;
  return <ComparisonConnection key={JSON.stringify([scope.accountId, scope.libraryId, scope.epoch])}
    binding={binding} request={request} allowRestore={canRestore} close={close} />;
}
function ComparisonConnection({ binding, request, allowRestore, close }: {
  binding: LibraryScopeBinding; request: DeletedContentComparisonRequest | null; allowRestore: boolean; close(): void;
}) {
  const library = useMemo(() => binding.sessions.getLibrary(), [binding.sessions]);
  const catalog = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const registry = useSyncExternalStore(binding.sessions.subscribe, binding.sessions.getSnapshot, binding.sessions.getSnapshot);
  const replication = useSyncExternalStore(binding.replication.subscribe, binding.replication.getSnapshot, binding.replication.getSnapshot);
  const lifetime = useRef({ active: false, generation: 0 });
  const openedRequest = useRef<DeletedContentComparisonRequest | null>(null);
  const session = useMemo(() => new DeletedContentComparisonSession({ repository: binding.repository,
    isActive: () => lifetime.current.active && binding.sessions.getSnapshot().active }), [binding.repository, binding.sessions]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useLayoutEffect(() => {
    const show = () => {
      lifetime.current.active = true; lifetime.current.generation++;
      session.setAvailable(binding.sessions.getSnapshot().active);
      session.setCatalog(library.getSelectedSnapshot());
      if (session.getSnapshot().selection) void session.refresh();
    };
    const hide = () => { lifetime.current.active = false; lifetime.current.generation++; session.setAvailable(false); };
    show(); window.addEventListener('pageshow', show); window.addEventListener('pagehide', hide);
    return () => {
      hide(); openedRequest.current = null; session.close();
      window.removeEventListener('pageshow', show); window.removeEventListener('pagehide', hide);
    };
  }, [binding.sessions, library, session]);
  useLayoutEffect(() => {
    session.setAvailable(registry.ready && registry.active && lifetime.current.active);
    session.setCatalog(library.getSelectedSnapshot());
  }, [registry.ready, registry.active, catalog, library, session]);
  useEffect(() => {
    if (!request) { openedRequest.current = null; session.close(); return; }
    if (openedRequest.current === request) return;
    const snapshot = library.getSelectedSnapshot();
    if (snapshot && registry.ready && registry.active) {
      openedRequest.current = request;
      void session.open(snapshot, request.deletionId, request.itemId);
    }
  }, [request, library, session, registry.ready, registry.active, catalog.ready, catalog.selectedVersion]);
  // Admission can wait for a selected catalog; subsequent polls never reopen an admitted request.
  useEffect(() => () => session.cancel(), [request, session]);
  useEffect(() => {
    if (registry.ready && registry.active && !replication.running && !replication.error && session.getSnapshot().selection) void session.refresh();
  }, [registry.ready, registry.active, replication.running, replication.error, session, state.selection?.itemId, state.selection?.deletionId]);
  useEffect(() => {
    const timer = setInterval(() => { if (session.getSnapshot().selection) void session.refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [session]);
  const ownerAvailable = state.targets.every(target => {
    const item = catalog.deletedItems.find(item => item.id === target.id);
    return !item?.ownerId || catalog.items.some(owner => owner.id === item.ownerId) || state.targets.some(owner => owner.id === item.ownerId);
  });
  const canRestore = allowRestore && registry.ready && registry.active && catalog.ready && !catalog.busy && !catalog.pendingId && !catalog.attachment
    && catalog.heads.length === 1 && !state.stale && ownerAvailable;
  const restore = async () => {
    const selection = session.getSnapshot().selection, generation = lifetime.current.generation;
    if (!selection || !canRestore || !lifetime.current.active) return false;
    const saved = await library.restoreDeleted(selection.deletionId);
    return saved && generation === lifetime.current.generation && lifetime.current.active && binding.sessions.getSnapshot().active
      && session.getSnapshot().selection?.deletionId === selection.deletionId;
  };
  return <DeletedContentComparisonPanel key={JSON.stringify([state.selection?.deletionId, state.selection?.itemId])}
    session={session} resources={binding.repository} canRestore={canRestore} restore={restore}
    available={registry.ready && registry.active && lifetime.current.active}
    close={() => { session.close(); close(); }} />;
}
