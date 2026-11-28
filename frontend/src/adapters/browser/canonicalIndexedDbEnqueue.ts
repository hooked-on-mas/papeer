import type { CanonicalInitializeRequest, CanonicalLibraryProfile, CanonicalLibraryInitializationIntent } from '../../runtime/edits/contracts.ts';
import { datasetAccess } from '../../runtime/edits/datasetControl.ts';

const key = (...parts: string[]) => JSON.stringify(parts);
/** Called only after Core has validated the empty initial publication and the write transaction has synchronously rechecked the captured footprint. No async work or nested repository transaction. */
export function enqueueInitialCanonicalRows(tx: IDBTransaction, request: CanonicalInitializeRequest, profile: CanonicalLibraryProfile, intent: CanonicalLibraryInitializationIntent): void {
  if ('retired' in intent || !intent.result || intent.result.status !== 'accepted') throw new Error('initialization-intent-not-accepted');
  const { manifest, checkpoint } = request.control.transition.publication, scope = manifest.scope;
  const identity = key(scope.accountId, scope.libraryId), namespace = key(scope.accountId, scope.libraryId, scope.epoch), root = checkpoint.roots[0];
  const put = (store: string, id: string, value: unknown) => tx.objectStore(store).add({ key: key(namespace, id), scope: namespace, value });
  put('roots', root.id, root);
  put('projections', `${root.id}:${root.version}`, root);
  put('checkpoints', manifest.checkpointSha256, true);
  put('datasets', manifest.id, manifest);
  tx.objectStore('datasetControls').add({ key: identity, scope: identity, value: request.control });
  tx.objectStore('datasetAccess').add({ key: identity, scope: identity, value: datasetAccess(request.control) });
  tx.objectStore('canonicalProfiles').add({ key: identity, scope: scope.accountId, value: profile });
  tx.objectStore('canonicalInitialArtifacts').add({ key: identity, scope: scope.accountId, value: { root, checkpoint, manifest } });
  tx.objectStore('canonicalInitialIntents').put({ key: key(scope.accountId, intent.requestId), scope: scope.accountId, value: intent });
}
