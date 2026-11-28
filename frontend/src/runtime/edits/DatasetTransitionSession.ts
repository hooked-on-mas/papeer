import type { DatasetControlRecord, DatasetPublication } from './contracts.ts';
import type { ContentRepository } from './ports.ts';
import type { EditTransferPort } from './replication.ts';
import { datasetAccess, datasetIdentity } from './datasetControl.ts';
import { canonicalJson, EditRejected } from './editModel.ts';
import { importPublishedDataset, publishDataset, readPublishedDataset, type DatasetPublicationPort } from './datasetPublication.ts';

type Transfer = DatasetPublicationPort & Pick<EditTransferPort, 'pull' | 'downloadResource' | 'imported'>;
type TransitionView = { running: boolean; record?: DatasetControlRecord; error: string };
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
/** Device-local control journal, publication retry and cutover. Host I/O stays in the ports.
 * beforeTransition stops/suspends editors and drains replication before freezing native state.
 */
export class DatasetTransitionSession {
  private state: TransitionView = immutable({ running: false, error: '' });
  private flight?: Promise<DatasetControlRecord>;
  private listeners = new Set<() => void>();
  private readonly repository: ContentRepository;
  private readonly transfer: Transfer;
  private readonly peerId: string;
  private readonly beforeTransition: (record: DatasetControlRecord | undefined) => Promise<boolean>;
  private readonly makeId: () => string;
  constructor(repository: ContentRepository, transfer: Transfer, peerId: string, beforeTransition: (record: DatasetControlRecord | undefined) => Promise<boolean>, makeId = () => crypto.randomUUID()) {
    this.repository = repository; this.transfer = transfer; this.peerId = peerId; this.beforeTransition = beforeTransition; this.makeId = makeId;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<TransitionView>) { this.state = immutable({ ...this.state, ...fields }); this.listeners.forEach(listener => listener()); }
  private checked(record: DatasetControlRecord | undefined): DatasetControlRecord {
    if (!record || canonicalJson(record.transition.publication.manifest.scope) !== canonicalJson(this.repository.scope)) throw new EditRejected('dataset-transition-scope');
    return record;
  }
  refresh = async () => { const record = await this.repository.datasetControl(); this.update({ record, error: '' }); return record; };
  private run(work: () => Promise<DatasetControlRecord>): Promise<DatasetControlRecord> {
    this.update({ running: true, error: '' });
    this.flight = Promise.resolve().then(work).then(record => { this.update({ record }); return record; })
      .catch(async error => {
        try { this.update({ record: await this.repository.datasetControl() }); } catch { /* Preserve the last known record while native state is unavailable. */ }
        this.update({ error: String(error) }); throw error;
      }).finally(() => { this.flight = undefined; this.update({ running: false }); });
    return this.flight;
  }
  private async guard() {
    const record = await this.repository.datasetControl();
    return this.quiesce(record);
  }
  private async quiesce(record: DatasetControlRecord | undefined) {
    if (!await this.beforeTransition(record)) throw new EditRejected('dataset-transition-guard');
    return record;
  }
  private async persist(previous: DatasetControlRecord, phase: DatasetControlRecord['transition']['phase']) {
    const record: DatasetControlRecord = { ...structuredClone(previous), id: this.makeId(), active: phase === 'activated' ? previous.transition.publication.manifest : previous.transition.source,
      transition: { ...structuredClone(previous.transition), phase } };
    if ((await this.repository.replaceDatasetControl(record, previous.id)).status !== 'written') throw new EditRejected('dataset-control-conflict');
    this.update({ record }); return record;
  }
  start(publication: DatasetPublication): Promise<DatasetControlRecord> {
    if (this.flight) return Promise.reject(new EditRejected('dataset-transition-running'));
    const stable = structuredClone(publication);
    return this.run(() => this.begin(stable, 'publish'));
  }
  join(manifestId: string): Promise<DatasetControlRecord> {
    if (this.flight) return Promise.reject(new EditRejected('dataset-transition-running'));
    return this.run(async () => {
      const plan = await readPublishedDataset(this.repository.scope, this.transfer, manifestId);
      return this.begin({ ...plan, checkpointObjectId: this.makeId() }, 'import');
    });
  }
  private async begin(stable: DatasetPublication, mode: DatasetControlRecord['transition']['mode']) {
    if (canonicalJson(stable.manifest.scope) !== canonicalJson(this.repository.scope)) throw new EditRejected('dataset-transition-scope');
    const previous = await this.guard();
    if (previous?.epochs.includes(stable.manifest.scope.epoch)) throw new EditRejected('dataset-epoch-reused');
    const record: DatasetControlRecord = { version: 1, id: this.makeId(), identity: datasetIdentity(this.repository.scope),
      epochs: [...(previous?.epochs ?? []), stable.manifest.scope.epoch], active: previous?.active ?? null,
      transition: { id: this.makeId(), mode, source: previous?.active ?? null, publication: stable, phase: 'prepared' } };
    if ((await this.repository.replaceDatasetControl(record, previous?.id ?? null)).status !== 'written') throw new EditRejected('dataset-control-conflict');
    this.update({ record }); return this.advance(record);
  }
  resume = (): Promise<DatasetControlRecord> => {
    if (this.flight) return this.flight;
    return this.run(async () => {
      const record = this.checked(await this.repository.datasetControl()); this.update({ record });
      if (['activated', 'rolled-back'].includes(record.transition.phase)) return record;
      await this.quiesce(record); return this.advance(record);
    });
  };
  private async advance(initial: DatasetControlRecord) {
    let record = initial;
    const publication = record.transition.publication;
    let verified = false;
    if (record.transition.phase === 'prepared') {
      if (record.transition.mode === 'publish') {
        await this.repository.installDataset(publication.manifest, publication.checkpoint);
        await publishDataset(publication, this.repository, this.transfer);
      } else { await importPublishedDataset(this.repository, this.transfer, publication.manifest.id, this.peerId); verified = true; }
      record = await this.persist(record, 'published');
    }
    if (record.transition.phase === 'published') {
      if (!verified) await importPublishedDataset(this.repository, this.transfer, publication.manifest.id, this.peerId);
      record = await this.persist(record, 'activated');
    }
    return record;
  }
  rollback = (): Promise<DatasetControlRecord> => {
    if (this.flight) return Promise.reject(new EditRejected('dataset-transition-running'));
    return this.run(async () => {
      const record = this.checked(await this.guard());
      return record.transition.phase === 'rolled-back' ? record : this.persist(record, 'rolled-back');
    });
  };
}

/** Production compositions must resolve this pointer; installed/imported does not mean active. */
export async function activeDatasetScope(repository: Pick<ContentRepository, 'datasetControl'>) {
  const record = await repository.datasetControl();
  if (!record?.active) throw new EditRejected('dataset-not-active');
  if (datasetAccess(record).frozen) throw new EditRejected('dataset-frozen');
  return { ...record.active.scope };
}
