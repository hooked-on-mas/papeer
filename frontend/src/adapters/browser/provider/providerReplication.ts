import type { ActiveLibraryProof, HostLease } from '../../../features/bootstrap/bootstrapPorts.ts';
import type { ResourceInspectionPort } from '../../../runtime/edits/ports.ts';
import { EditReplication, type EditTransferPort } from '../../../runtime/edits/replication.ts';
import { createPlanEvidence, fingerprintPlanInput } from '../../../runtime/edits/repositoryExecution.ts';
import { createPlannedRepositoryDraft } from '../../../runtime/edits/repositoryFacadeDraft.ts';
import { IndexedDbPlan } from '../indexedDbPlan.ts';
import type { LocalHostAuthority } from '../localHostAuthority.ts';

/** The privileged repository remains host-private. Product views receive only the sync surface. */
export function createProviderReplication(authority: LocalHostAuthority, lease: HostLease, proof: ActiveLibraryProof,
  transfer: EditTransferPort, io: { signal(): AbortSignal; cancel(): void; renew(): void }, inspection?: ResourceInspectionPort) {
  const fresh = () => authority.refreshProvider(proof, io.signal());
  const remote = async <T>(action: () => Promise<T>): Promise<T> => { await fresh(); const value = await action(); await fresh(); return value; };
  const guarded: EditTransferPort = {
    pull: options => remote(() => transfer.pull(options)), upload: record => remote(() => transfer.upload(record)),
    uploadResource: resource => remote(() => transfer.uploadResource(resource)), downloadResource: metadata => remote(() => transfer.downloadResource(metadata)),
    imported: (batchId, peerId) => remote(() => transfer.imported(batchId, peerId)),
    ...(transfer.acknowledgePull ? { acknowledgePull: (batches: string[], receipts: string[], resources: string[]) => transfer.acknowledgePull!(batches, receipts, resources) } : {}),
  };
  const repository = createPlannedRepositoryDraft(proof.scope, {
    createEvidence: (operation, fixed) => createPlanEvidence(fingerprintPlanInput(operation, fixed)),
    run: async (_operation, evidence, action) => {
      const host = authority.captureProviderReplication(lease, proof, io.signal());
      return authority.withOperationDatabase(host, () => action(new IndexedDbPlan(authority, host, proof.scope, evidence.bind(host))));
    },
  }, inspection);
  const replication = new EditReplication(repository, guarded, authority.admittedPeerId(proof));
  replication.suspend();
  let timer: ReturnType<typeof setTimeout> | undefined, flight: Promise<void> | undefined, stopEpoch = 0, autoEnabled = false;
  const pass = (resume: boolean): Promise<void> => {
    if (flight) return flight;
    if (!resume && replication.getSnapshot().suspended) return Promise.resolve();
    clearTimeout(timer); timer = undefined;
    const requestedEpoch = stopEpoch, signal = io.signal();
    const current = (async () => {
      const selected = await authority.beginProviderSync(proof, signal);
      try {
        selected.assertCurrent();
        if (resume) await replication.resume(); else await replication.flush();
        if (!signal.aborted) { await fresh(); selected.assertCurrent(); }
      } finally { selected.release(); }
    })().finally(() => {
      if (flight !== current) return;
      flight = undefined;
      if (autoEnabled && requestedEpoch === stopEpoch && !replication.getSnapshot().suspended) {
        const next = setTimeout(() => {
          if (timer !== next) return;
          timer = undefined;
          if (autoEnabled && requestedEpoch === stopEpoch) void flush().catch(() => undefined);
        }, 5000);
        timer = next;
      }
    });
    flight = current; return current;
  };
  const flush = () => pass(false);
  const suspend = () => { autoEnabled = false; stopEpoch++; clearTimeout(timer); timer = undefined; replication.suspend(); io.cancel(); };
  return Object.freeze({ scope: replication.scope, getSnapshot: replication.getSnapshot, subscribe: replication.subscribe,
    flush, suspend,
    suspendAndWait: async () => { suspend(); await flight?.catch(() => undefined); await replication.suspendAndWait(); },
    resume: async () => {
      const requestedEpoch = stopEpoch;
      await flight?.catch(() => undefined);
      if (requestedEpoch !== stopEpoch) return;
      io.renew();
      autoEnabled = true;
      await pass(true);
    },
  });
}
