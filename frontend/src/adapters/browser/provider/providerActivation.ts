import type { ProviderGrant, RemoteLibraryHandle, ProviderOperationOutcome } from '../../../features/bootstrap/bootstrapPorts.ts';
import type { ResourceInspectionPort } from '../../../runtime/edits/ports.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { resourceHash } from '../../../runtime/edits/contentPublication.ts';
import { datasetAccess } from '../../../runtime/edits/datasetControl.ts';
import { datasetRecord } from '../../../runtime/edits/datasetControl.ts';
import type { StoredEdit } from '../../../runtime/edits/repository.ts';
import type { ResourceMetadata } from '../../../runtime/edits/contracts.ts';
import { assertProviderOwnerPlan, providerActivationMetadata, type ProviderOwnerPlan } from '../../../runtime/edits/provider/providerOwnerPlan.ts';
import { prepareProviderInstall } from '../../../runtime/edits/provider/providerInstallPlan.ts';
import type { LocalHostAuthority } from '../localHostAuthority.ts';
import { ProviderGrantIssuer, type ProviderHostOperation } from '../ownership/providerGrantIssuer.ts';
import { sameStoredValue } from '../repository/indexedDbMutationWriter.ts';
import { assertProviderInstallTargetEmpty, captureProviderActivation, commitProviderActivation, loadProviderOwnerPlan,
  type ProviderActivationFootprint } from './providerActivationStore.ts';

const key = (...parts: string[]) => JSON.stringify(parts);

/** Host-owned install/activation; the renderer supplies only opaque handles and its retained request ID. */
export class ProviderActivation {
  private readonly authority: LocalHostAuthority;
  private readonly issuer: ProviderGrantIssuer;
  private readonly inspection?: ResourceInspectionPort;

  constructor(authority: LocalHostAuthority, issuer: ProviderGrantIssuer, inspection?: ResourceInspectionPort) {
    this.authority = authority;
    this.issuer = issuer;
    this.inspection = inspection;
  }

  private owner(operation: ProviderHostOperation) {
    const captured = this.issuer.inspectProviderOperation(operation), local = this.authority.captureRecord(captured.host);
    if (local.family !== 'namespace-owner' || local.tuple !== null) throw new Error('provider-owner-invalid');
    return { captured, namespace: local.grant.namespaceId };
  }

  private matches(operation: ProviderHostOperation, plan: ProviderOwnerPlan): void {
    const { captured, namespace } = this.owner(operation);
    if (namespace !== plan.ownerNamespace || captured.principal.digest !== plan.principalDigest
      || captured.descriptor.id !== plan.descriptor.id || captured.descriptor.sha256 !== plan.descriptor.sha256
      || captured.descriptor.folderId !== plan.folderId || captured.descriptor.title !== plan.title
      || (plan.descriptor.version !== null && captured.descriptor.version !== plan.descriptor.version)
      || !plan.binding || captured.descriptor.version !== plan.binding.descriptorVersion
      || canonicalJson(captured.canonical.scope) !== canonicalJson(plan.intent.scope)
      || !sameStoredValue(captured.bytes, plan.descriptorBytes)) throw new Error('provider-activation-evidence-changed');
  }

  private async installed(plan: ProviderOwnerPlan, footprint: ProviderActivationFootprint): Promise<void> {
    const expected = await providerActivationMetadata(plan), scope = plan.intent.scope;
    const identity = key(scope.accountId, scope.libraryId), namespace = key(scope.accountId, scope.libraryId, scope.epoch);
    if (plan.intent.phase !== 'activated' || plan.binding?.state !== 'active'
      || footprint.profile?.key !== identity || footprint.profile.scope !== scope.accountId || !sameStoredValue(footprint.profile.value, expected.profile)
      || footprint.peer?.key !== scope.accountId || footprint.peer.scope !== scope.accountId || !sameStoredValue(footprint.peer.value, expected.peer)
      || footprint.control?.key !== identity || footprint.control.scope !== identity || !sameStoredValue(footprint.control.value, expected.controls[2])
      || footprint.access?.key !== identity || footprint.access.scope !== identity || !sameStoredValue(footprint.access.value, datasetAccess(expected.controls[2]))
      || !footprint.scoped.datasets.some(row => row.key === key(namespace, plan.publication.manifest.id) && sameStoredValue(row.value, plan.publication.manifest))
      || !footprint.scoped.checkpoints.some(row => row.key === key(namespace, plan.publication.manifest.checkpointSha256) && row.value === true))
      throw new Error('provider-activation-incomplete');
    for (const root of plan.publication.checkpoint.roots) {
      const row = footprint.scoped.roots.find(value => value.key === key(namespace, root.id));
      if (!row || !sameStoredValue(row.value, root)) throw new Error('provider-installed-root-changed');
    }
    for (const record of plan.publication.checkpoint.edits) {
      const row = footprint.scoped.edits.find(value => value.key === key(namespace, record.batch.id)), stored = row?.value as StoredEdit | undefined;
      if (!stored || !sameStoredValue(datasetRecord(stored), record) || stored.receipt.durable !== true
        || stored.receipt.id !== record.batch.id || stored.receipt.targetId !== record.batch.targetId)
        throw new Error('provider-installed-edit-changed');
    }
    for (const expectedResource of plan.publication.manifest.resources) {
      const row = footprint.scoped.resources.find(value => value.key === key(namespace, expectedResource.id));
      const resource = row?.value as ResourceMetadata | undefined;
      const bytes = footprint.scoped.resourceBytes.find(value => value.key === key(namespace, expectedResource.sha256))?.value;
      if (!sameStoredValue(resource, expectedResource) || !(bytes instanceof Uint8Array)
        || bytes.byteLength !== expectedResource.byteLength || await resourceHash(bytes) !== expectedResource.sha256)
        throw new Error('provider-installed-resource-changed');
    }
  }

  async execute(grant: ProviderGrant, handle: RemoteLibraryHandle, requestId: string, signal: AbortSignal): Promise<ProviderOperationOutcome> {
    const operation = await this.issuer.captureProviderOperation(grant, handle, signal);
    let sent = false, aborted = false, committed = false;
    try {
      const { captured, namespace } = this.owner(operation), guard = () => { this.owner(operation); };
      const plan = await loadProviderOwnerPlan(this.authority, captured.host, namespace, requestId, guard);
      if (!plan) return { requestId, status: 'not-found' };
      await assertProviderOwnerPlan(plan); this.matches(operation, plan);
      const footprint = await captureProviderActivation(this.authority, captured.host, namespace, plan, guard);
      if (plan.intent.phase === 'activated') {
        await this.installed(plan, footprint); this.matches(operation, plan);
        return { requestId, status: 'accepted' };
      }
      if (plan.binding?.state !== 'preparing' || plan.intent.phase !== 'published')
        throw new Error('provider-activation-phase');
      const metadata = await providerActivationMetadata(plan); guard(); assertProviderInstallTargetEmpty(footprint, metadata.peer);
      const resources = footprint.stages.map(stage => stage!.value);
      const install = await prepareProviderInstall(plan, resources, this.inspection); this.matches(operation, plan);
      await commitProviderActivation(this.authority, captured.host, namespace, plan, footprint, install, guard,
        { sent: () => { sent = true; }, aborted: () => { aborted = true; }, completed: () => { committed = true; } });
      // A remote change after local commit cannot be described as rollback. The
      // next same-request query may confirm activation after fresh authentication.
      await this.issuer.resolve(grant, handle, plan.intent.scope, signal); this.matches(operation, plan);
      return { requestId, status: 'accepted' };
    } catch (error) {
      if (committed || (sent && !aborted)) return { requestId, status: 'unknown' };
      throw error;
    } finally { this.issuer.releaseProviderOperation(operation); }
  }
}
