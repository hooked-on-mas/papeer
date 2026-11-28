import type { EditIntent, EditIntentRecord } from './contracts.ts';
import type { EditIntentRepository } from './ports.ts';
import { assertEditIntent } from './editIntent.ts';
import { canonicalJson } from './editModel.ts';

export interface BatchIntentJournal {
  save(intent: EditIntent): Promise<void>;
  clear(): Promise<void>;
}

/** Serial CAS writes. A lost reply retains the exact mutation ID until it is confirmed;
 * a newer Undo request cannot overtake it or replace another tab's recovery record.
 */
export class EditIntentJournal implements BatchIntentJournal {
  private readonly repository: EditIntentRepository;
  private readonly targetId: string;
  private readonly makeId: () => string;
  private current?: EditIntentRecord;
  private loaded = false;
  private loading?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private mutation?: { record: EditIntentRecord | null; expectedId: string | null };
  constructor(repository: EditIntentRepository, targetId: string, makeId: () => string = () => crypto.randomUUID()) {
    this.repository = repository; this.targetId = targetId; this.makeId = makeId;
  }
  async load(): Promise<EditIntentRecord | undefined> {
    if (!this.loaded) {
      this.loading ??= this.repository.readIntent(this.targetId).then(record => {
        if (record) assertEditIntent(record, this.repository.scope.libraryId, this.targetId);
        this.current = record ? structuredClone(record) : undefined; this.loaded = true;
      }).finally(() => { this.loading = undefined; });
      await this.loading;
    }
    return this.current ? structuredClone(this.current) : undefined;
  }
  async reload(): Promise<EditIntentRecord | undefined> {
    await this.tail.catch(() => undefined);
    if (this.mutation) throw new Error('intent-update-unconfirmed');
    this.loaded = false;
    return this.load();
  }
  private async completeMutation(): Promise<void> {
    const mutation = this.mutation; if (!mutation) return;
    const result = await this.repository.replaceIntent(this.targetId, mutation.record, mutation.expectedId);
    if (result?.status === 'conflict') throw new Error('intent-owned-by-another-session');
    if (result?.status !== (mutation.record ? 'written' : 'cleared')) throw new Error('invalid-intent-response');
    this.current = mutation.record ? structuredClone(mutation.record) : undefined;
    this.mutation = undefined;
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const flight = this.tail.catch(() => undefined).then(async () => {
      await this.load(); await this.completeMutation(); await run();
    });
    this.tail = flight; void flight.catch(() => undefined); return flight;
  }
  save(intent: EditIntent): Promise<void> {
    const stable = structuredClone(intent);
    return this.enqueue(async () => {
      if (this.current && canonicalJson(this.current.intent) === canonicalJson(stable)) return;
      const record = { id: this.makeId(), intent: stable };
      assertEditIntent(record, this.repository.scope.libraryId, this.targetId);
      this.mutation = { record, expectedId: this.current?.id ?? null };
      await this.completeMutation();
    });
  }
  clear(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.current) return;
      this.mutation = { record: null, expectedId: this.current.id };
      await this.completeMutation();
    });
  }
}
