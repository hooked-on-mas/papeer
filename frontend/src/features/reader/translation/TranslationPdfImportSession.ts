import type { Page, TranslationBinding } from '../../../runtime/edits/contracts.ts';
import type { ContentRepository } from '../../../runtime/edits/ports.ts';
import { assertResourceMetadata, resourceHash } from '../../../runtime/edits/contentPublication.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import type { DocumentCommandResult, DocumentEditSession } from '../edit/DocumentEditSession.ts';

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_PAGES = 10_000;
export type TranslationImportPage = Readonly<{ pageId: string; pdfPage: number; widthPt: number; heightPt: number; originalPageId: string | null | undefined }>;
export type TranslationImportState = Readonly<{ phase: 'idle' | 'reading' | 'error' | 'ready' | 'submitting'; error: string;
  sourceVersion: string | null; replacing: boolean; pages: readonly TranslationImportPage[]; originalPages: readonly Readonly<{pageId: string; pageNumber: number}>[] }>;
type Host = { repository: Pick<ContentRepository, 'scope' | 'read' | 'storeResource' | 'readResource'>; document: DocumentEditSession;
  active(): boolean; inputBlocked(): boolean; makeId(): string };
type Draft = { generation: number; scope: string; version: string; heads: string; resourceId: string; read(): Promise<Uint8Array>;
  bytes?: Uint8Array; sha256?: string; pageIds?: { id: string; backgroundRevision: string }[]; metadata?: Awaited<ReturnType<ContentRepository['storeResource']>> };

/** One scope-owned, retryable import; no mapping is inferred from page order. */
export class TranslationPdfImportSession {
  private state: TranslationImportState = Object.freeze({ phase:'idle', error:'', sourceVersion:null, replacing:false, pages:Object.freeze([]), originalPages:Object.freeze([]) });
  private readonly listeners = new Set<() => void>();
  private generation = 0; private draft?: Draft; private flight?: Promise<boolean>; private disposed = false;
  private readonly host: Host;
  constructor(host: Host) { this.host = host; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<TranslationImportState>) {
    const next = { ...this.state, ...fields }; next.pages = Object.freeze(next.pages.map(page => Object.freeze({ ...page }))); next.originalPages = Object.freeze(next.originalPages.map(page => Object.freeze({ ...page })));
    this.state = Object.freeze(next); this.listeners.forEach(listener => listener());
  }
  canLeave = () => this.state.phase === 'idle';
  private valid(draft: Draft) { return !this.disposed && this.draft === draft && draft.generation === this.generation && this.host.active()
    && canonicalJson(this.host.repository.scope) === draft.scope; }
  private current(draft: Draft) {
    const state = this.host.document.getSnapshot();
    if (!this.valid(draft) || !state.ready || !state.document || state.selectedVersion !== draft.version || state.document.version !== draft.version
      || canonicalJson([...state.heads].sort()) !== draft.heads) throw new Error('translation-import-stale');
    if (state.inputActive || this.host.inputBlocked() || !this.host.document.canNavigate()) throw new Error('translation-import-input-pending');
    return state.document;
  }
  async stage(read: () => Promise<Uint8Array>): Promise<boolean> {
    if (this.disposed || this.state.phase !== 'idle' || !this.host.active()) return false;
    const state = this.host.document.getSnapshot();
    if (!state.ready || !state.document || !state.selectedVersion || state.selectedVersion !== state.document.version
      || state.inputActive || this.host.inputBlocked() || !this.host.document.canNavigate()) { this.update({error:'translation-import-input-pending'}); return false; }
    const generation = ++this.generation;
    const draft: Draft = { generation, scope: canonicalJson(this.host.repository.scope), version: state.document.version,
      heads: canonicalJson([...state.heads].sort()), resourceId: this.host.makeId(), read };
    this.draft = draft; this.update({phase:'reading',error:'',sourceVersion:draft.version,replacing:!!state.document.translation,pages:[],originalPages:state.document.pages.flatMap((page,index)=>page.background.kind==='pdf'?[{pageId:page.id,pageNumber:index+1}]:[])});
    return this.prepare(draft);
  }
  retry = () => this.draft && this.state.phase === 'error' ? this.prepare(this.draft) : Promise.resolve(false);
  private prepare(draft: Draft): Promise<boolean> {
    if (this.flight) return this.flight;
    this.update({phase:'reading',error:''});
    const work = (async () => {
      try {
        this.current(draft);
        if (!draft.bytes) {
          const input = await draft.read(); this.current(draft);
          if (!(input instanceof Uint8Array) || !input.length || input.length > MAX_BYTES) throw new Error('translation-import-size');
          draft.bytes = Uint8Array.from(input);
        }
        draft.sha256 ??= await resourceHash(draft.bytes); this.current(draft);
        const metadata = await this.host.repository.storeResource({id:draft.resourceId,sha256:draft.sha256,mediaType:'application/pdf',bytes:Uint8Array.from(draft.bytes),...(draft.metadata ? {expected:draft.metadata} : {})});
        this.current(draft); assertResourceMetadata(metadata);
        if (metadata.id !== draft.resourceId || metadata.sha256 !== draft.sha256 || metadata.mediaType !== 'application/pdf'
          || metadata.byteLength !== draft.bytes.length || !metadata.pdfPages?.length || metadata.pdfPages.length > MAX_PAGES) throw new Error('translation-import-metadata');
        if (draft.metadata && canonicalJson(metadata)!==canonicalJson(draft.metadata)) throw new Error('translation-import-metadata');
        draft.metadata = structuredClone(metadata);
        const stored = await this.host.repository.readResource(draft.resourceId); this.current(draft);
        if (!stored || canonicalJson(stored.metadata)!==canonicalJson(metadata) || stored.bytes.length!==draft.bytes.length
          || await resourceHash(stored.bytes)!==draft.sha256) throw new Error('translation-import-readback');
        this.current(draft);
        draft.pageIds ??= metadata.pdfPages.map(() => ({id:this.host.makeId(),backgroundRevision:this.host.makeId()}));
        const pages = metadata.pdfPages.map((p,index) => ({pageId:draft.pageIds![index].id,pdfPage:index+1,widthPt:p.widthPt,heightPt:p.heightPt,originalPageId:undefined}));
        this.update({phase:'ready',pages,error:''}); return true;
      } catch (error) {
        if (this.valid(draft)) this.update({phase:'error',error:error instanceof Error ? error.message : 'translation-import-failed'});
        return false;
      }
    })();
    this.flight = work; void work.finally(() => { if (this.flight === work) this.flight = undefined; }); return work;
  }
  setMapping(index: number, originalPageId: string | null): boolean {
    const draft=this.draft;if (!draft || this.state.phase!=='ready' || !Number.isInteger(index) || index<0 || index>=this.state.pages.length) return false;
    try { const document=this.current(draft); if (originalPageId!==null && !document.pages.some(page=>page.id===originalPageId && page.background.kind==='pdf')) return false; }
    catch { return false; }
    const pages=this.state.pages.map((page,i)=>i===index?{...page,originalPageId}:page);this.update({pages});return true;
  }
  async submit(): Promise<DocumentCommandResult> {
    const draft=this.draft;if (!draft || this.state.phase!=='ready') return {status:'refused',reason:'translation-import-not-ready'};
    try {
      const fixed=this.state.pages.map(page=>({...page})); if (fixed.some(page=>page.originalPageId===undefined)) throw new Error('translation-import-mapping-required');
      this.current(draft);
      this.update({phase:'submitting',error:''});
      const read=await this.host.repository.read(this.host.document.documentId); this.current(draft);
      if (canonicalJson([...read.heads].sort())!==draft.heads || !read.heads.includes(draft.version)) throw new Error('translation-import-stale-head');
      const result=await this.host.document.buildDocumentEdit((document,batchId)=>{
        if (!this.valid(draft) || document.version!==draft.version || this.host.inputBlocked()) throw new Error('translation-import-stale');
        const pages: Page[]=fixed.map((p,index)=>({id:p.pageId,backgroundRevision:draft.pageIds![index].backgroundRevision,lifecycleVersion:batchId,annotationVersion:batchId,
          widthPt:p.widthPt,heightPt:p.heightPt,background:{kind:'pdf',resourceId:draft.resourceId,sourceRevision:draft.sha256!,pdfPage:p.pdfPage},annotations:[]}));
        const bindings: TranslationBinding[]=[];
        for (const row of fixed) if (row.originalPageId!==null && row.originalPageId!==undefined) {
          const original=document.pages.find(page=>page.id===row.originalPageId && page.background.kind==='pdf');
          if (!original) throw new Error('translation-import-source-missing');
          let binding=bindings.find(value=>value.original.pageId===original.id);
          if (!binding) { binding={original:{pageId:original.id,backgroundRevision:original.backgroundRevision},candidates:[]}; bindings.push(binding); }
          const page=pages[row.pdfPage-1]; binding.candidates.push({pageId:page.id,backgroundRevision:page.backgroundRevision});
        }
        return [{type:'translation',expectedRevision:document.translation?.revision ?? null,translation:{pages,bindings}}];
      });
      if (result.status==='applied') { if (this.draft===draft) {this.draft=undefined;this.update({phase:'idle',error:'',sourceVersion:null,replacing:false,pages:[],originalPages:[]});} }
      else if (this.valid(draft)) this.update({phase:'ready',error:result.status==='refused'?result.reason:'translation-import-unchanged'});
      return result;
    } catch (error) {
      const reason=error instanceof Error?error.message:'translation-import-failed'; if (this.valid(draft)) this.update({phase:'ready',error:reason});
      return {status:'refused',reason};
    }
  }
  cancel(): boolean {
    if (this.state.phase==='submitting') return false;
    this.generation++;this.draft=undefined;this.flight=undefined;this.update({phase:'idle',error:'',sourceVersion:null,replacing:false,pages:[],originalPages:[]});return true;
  }
  activate(): void { if (this.disposed) { this.disposed=false; this.generation++; } }
  dispose(): void { this.disposed=true;this.generation++;this.draft=undefined;this.flight=undefined;this.update({phase:'idle',error:'',sourceVersion:null,replacing:false,pages:[],originalPages:[]}); }
}
