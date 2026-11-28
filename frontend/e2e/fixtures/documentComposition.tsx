import { IndexedDbPlan } from '../../src/adapters/browser/indexedDbPlan.ts';
import { EditorView } from '@codemirror/view';
import type { FixtureTimingSpan, FixtureTimingSnapshot } from '../support/provider/fakeDrive.ts';
import { createRoot } from 'react-dom/client';
import { lazy, StrictMode, Suspense } from 'react';
import { createWebBootstrap } from '../../src/web/bootstrapComposition.ts';
import { createDesktopBootstrapHost } from '../../src/adapters/desktop/bootstrapEntry.ts';
import { DesktopBootstrapApp } from '../../src/adapters/desktop/DesktopBootstrapApp.tsx';
import { BootstrapConnection } from '../../src/features/bootstrap/BootstrapConnection.tsx';
import type { LibraryRuntime } from '../../src/features/bootstrap/bootstrapPorts.ts';
import type { ContentRepository, EditScope, RepositoryState } from '../../src/runtime/edits/ports.ts';
import type { ContentPublication, LibrarySnapshot, ResourceMetadata } from '../../src/runtime/edits/contracts.ts';
import type { DocumentLibraryBinding } from '../../src/features/reader/DocumentLibraryBinding.ts';
import type { DocumentEditSessions } from '../../src/features/reader/DocumentEditSessions.ts';
import { readReferenceInputSnapshot } from '../../src/features/reader/reference/useDocumentReferencePlace';
import { readHighlightDiagnostic } from '../../src/features/reader/highlightDiagnostics';

// Registered before the dynamic desktop/web mount below installs Reader input listeners.
type ReferenceSnapshot = ReturnType<typeof readReferenceInputSnapshot>;
type ReferenceKeyObserver = { referenceKeyObserverArmed?: boolean; compositionReferenceInputEvidence(): ReferenceSnapshot;
  referenceKeyEvidence?: { trusted: boolean; before: ReferenceSnapshot; width: number; after?: ReferenceSnapshot } };
const referenceKeyObserver = window as unknown as ReferenceKeyObserver;
let pendingReferenceKey: KeyboardEvent | null = null;
window.addEventListener('keydown', event => {
  if (!referenceKeyObserver.referenceKeyObserverArmed || !event.isTrusted || !event.ctrlKey || event.code !== 'Equal') return;
  referenceKeyObserver.referenceKeyObserverArmed = false;
  const width = document.querySelector<HTMLElement>('[data-reader-reference] [data-pdf-surface]')?.getBoundingClientRect().width ?? 0;
  const evidence = { trusted: event.isTrusted, before: referenceKeyObserver.compositionReferenceInputEvidence(), width } as NonNullable<ReferenceKeyObserver['referenceKeyEvidence']>;
  referenceKeyObserver.referenceKeyEvidence = evidence;
  pendingReferenceKey = event;
}, true);
document.addEventListener('keydown', event => {
  if (event !== pendingReferenceKey) return;
  pendingReferenceKey = null;
  const evidence = referenceKeyObserver.referenceKeyEvidence;
  if (evidence) evidence.after = referenceKeyObserver.compositionReferenceInputEvidence();
}, true);

// The fixture owns a normal host/session. No binding, owner, lease or verifier is an input.
const config = await (await fetch('/composition/config')).json() as {
  scope: EditScope; documentId: string; contentKind: 'document' | 'markdown'; emptyScope?: boolean;
  loopbackToken: string; seededContents: { id: string; kind: 'document' | 'markdown' }[];
};
const initialId = new URLSearchParams(location.search).get('initialDocumentId');
if (initialId) {
  const selected = config.seededContents.find(value => value.id === initialId);
  if (!selected) throw new Error('fixture-initial-content-not-seeded');
  config.documentId = selected.id; config.contentKind = selected.kind;
}
const native = new URLSearchParams(location.search).get('host') === 'native';
const measureFlush=new URLSearchParams(location.search).get('startupDiagnostics')==='1';
const planTimings:FixtureTimingSpan[]=[];let planSequence=0;
const planSnapshot=():FixtureTimingSnapshot=>({sequence:planSequence,entries:planTimings.map(value=>({...value}))});
if(measureFlush&&!native){
  const operations=new Set(['read','read-intent','pending-intents','replace-intent','checkpoint','dataset-control','datasets','store-resource','read-resource','resource-metadata','commit','publish','receive-records','receipt','pending','pending-records','pending-publications','acknowledge-upload','acknowledge-import']);
  const mutationKinds=new Set(['put-root','put-edit','put-intent','put-dataset','put-control','put-resource','remember-checkpoint','put-projection','prune-projections']);
  const capture=IndexedDbPlan.prototype.capture,apply=IndexedDbPlan.prototype.compareAndApply;
  const observe=<T,>(promise:Promise<T>,span:FixtureTimingSpan)=>{planTimings.push(span);if(planTimings.length>256)planTimings.shift();
    const end=(outcome:string)=>{span.finished=performance.now();span.outcome=outcome;};
    void promise.then(()=>end('fulfilled'),()=>end('rejected'));return promise;
  };
  IndexedDbPlan.prototype.capture=function(...args:Parameters<typeof capture>){
    const span:FixtureTimingSpan={sequence:++planSequence,started:performance.now(),category:operations.has(args[0])?args[0]:'other',method:'capture'};
    const promise=capture.apply(this,args);return observe(promise,span);
  };
  IndexedDbPlan.prototype.compareAndApply=function(...args:Parameters<typeof apply>){
    const span:FixtureTimingSpan={sequence:++planSequence,started:performance.now(),category:operations.has(args[0])?args[0]:'other',method:'compareAndApply'};
    const promise=apply.apply(this,args);
    try{const counts:Record<string,number>={};for(const mutation of args[1].mutations){const kind=mutationKinds.has(mutation.kind)?mutation.kind:'other';counts[kind]=(counts[kind]??0)+1;}span.mutations=counts;}catch{/* diagnostic only; preserve the original promise */}
    return observe(promise,span);
  };
}
// B13-g test hook (Web host only, off unless a test arms it). The Web repository has no transport whose reply can be lost, so the unknown outcome is
// produced at the IndexedDbPlan boundary: the real compare-and-apply of a commit/publish runs to completion (the batch really is durable in IndexedDB),
// and then the reply is lost by throwing; the repository facade turns that exception into { status: 'unknown' }. It only records what happened.
if(!native){
  const state={loseReplies:false,calls:[] as {operation:string;batchIds:string[];lost:boolean}[]};
  const applyOriginal=IndexedDbPlan.prototype.compareAndApply;
  IndexedDbPlan.prototype.compareAndApply=async function(...args:Parameters<typeof applyOriginal>){
    const result=await applyOriginal.apply(this,args);
    if(args[0]==='commit'||args[0]==='publish'){
      const batchIds=args[1].mutations.flatMap(mutation=>mutation.kind==='put-edit'?[mutation.edit.batch.id]:[]);
      const lost=state.loseReplies&&result.status==='committed';
      state.calls.push({operation:args[0],batchIds,lost});
      if(lost)throw new Error('fixture web reply lost after durable apply');
    }
    return result;
  };
  Object.assign(window,{compositionWebReplyLoss:(lose:boolean)=>{state.loseReplies=lose;},compositionWebCommitCalls:()=>state.calls.map(call=>({...call,batchIds:[...call.batchIds]}))});
}

// Use each normal entry's stylesheet before creating the host or rendering its views.
if (native) await import('../../src/index.css');
else await import('../../src/web/style.css');
let scratchQuota = false;
const setItem = Storage.prototype.setItem;
Storage.prototype.setItem = function(key: string, value: string) {
  if (scratchQuota && (key.startsWith('paper-desk.markdown-draft.v1:') || key.startsWith('paper-desk.annotation-append.v1:')))
    throw new DOMException('Fixture scratch quota', 'QuotaExceededError');
  return setItem.call(this,key,value);
};
type NativeTransportEvent = { sequence: number; request: number; atMs: number; endpoint: string; phase: string; signalAborted: boolean; status?: number; name?: string; message?: string; active?: boolean | 'missing' };
const nativeTransportStarted = performance.now(), nativeTransportOriginEpochMs = Date.now();
const nativeTransportRecent: NativeTransportEvent[] = [], nativeTransportFailures: NativeTransportEvent[] = [], nativeTransportHealth: NativeTransportEvent[] = [], nativeTransportReplication: NativeTransportEvent[] = [];
let nativeTransportSequence = 0, nativeTransportRequest = 0, nativeTransportDropped = 0, nativeTransportFailureDropped = 0, nativeTransportHealthDropped = 0, nativeTransportReplicationDropped = 0;
const nativeTransportSnapshot = () => ({ originEpochMs:nativeTransportOriginEpochMs, recent: nativeTransportRecent.map(value=>({...value})), failures: nativeTransportFailures.map(value=>({...value})), health: nativeTransportHealth.map(value=>({...value})), dropped: nativeTransportDropped, failureDropped: nativeTransportFailureDropped, healthDropped: nativeTransportHealthDropped, replication:nativeTransportReplication.map(value=>({...value})), replicationDropped:nativeTransportReplicationDropped });
const observeNativeTransport = (request: number, endpoint: string, phase: string, signal: AbortSignal | null | undefined, status?: number, error?: unknown, active?: boolean | 'missing') => {
  if (!measureFlush) return;
  try {
    const entry: NativeTransportEvent = { sequence: ++nativeTransportSequence, request, atMs: Math.round(performance.now()-nativeTransportStarted), endpoint, phase, signalAborted: signal?.aborted===true, status, active,
      name: error instanceof Error ? error.name.slice(0,80) : error===undefined ? undefined : typeof error,
      message: error instanceof Error ? (phase==='json-error' && error.name==='SyntaxError' ? 'JSON parse failed (body omitted)' : error.message.replace(/https?:\/\/\S+/g,'[url]').slice(0,256)) : error===undefined ? undefined : 'non-Error transport failure' };
    nativeTransportRecent.push(entry); if(nativeTransportRecent.length>64){nativeTransportRecent.shift();nativeTransportDropped++;}
    if(phase.endsWith('error') || (status!==undefined && status>=400)){nativeTransportFailures.push(entry);if(nativeTransportFailures.length>32){nativeTransportFailures.shift();nativeTransportFailureDropped++;}}
    if(endpoint==='/api/edits/provider-owner/health'){nativeTransportHealth.push(entry);if(nativeTransportHealth.length>8){nativeTransportHealth.shift();nativeTransportHealthDropped++;}}
    if(endpoint.startsWith('/api/edits/provider-owner/replication/')){nativeTransportReplication.push(entry);if(nativeTransportReplication.length>64){nativeTransportReplication.shift();nativeTransportReplicationDropped++;}}
  } catch { /* observation must never alter the original transport outcome */ }
};
if (native) Object.assign(window,{__PAPEER_TOKEN:config.loopbackToken,__PAPEER_PORT:Number(location.port)});
const desktop = native ? createDesktopBootstrapHost({fetcher: (input,init) => {
  const url = new URL(String(input));
  if(!measureFlush)return fetch(url.pathname+url.search,init);
  const request=++nativeTransportRequest, endpoint=url.pathname.startsWith('/api/edits/') ? url.pathname : 'other', signal=init?.signal;
  observeNativeTransport(request,endpoint,'request',signal);
  let promise: Promise<Response>;
  try { promise=fetch(url.pathname+url.search,init); }
  catch(error){observeNativeTransport(request,endpoint,'fetch-error',signal,undefined,error);throw error;}
  void promise.then(response=>{
    observeNativeTransport(request,endpoint,'fetch-response',signal,response.status);
    try {
      const json=response.json;
      Object.defineProperty(response,'json',{configurable:true,writable:true,value:function(this:Response,...args:Parameters<Response['json']>){
        observeNativeTransport(request,endpoint,'json-start',signal,response.status);
        let result: ReturnType<Response['json']>;
        try { result=json.apply(this,args); }
        catch(error){observeNativeTransport(request,endpoint,'json-error',signal,response.status,error);throw error;}
        void result.then(value=>{
          let active: boolean | 'missing' | undefined;
          if(endpoint==='/api/edits/provider-owner/health'){
            active='missing';try{if(value && typeof value==='object' && typeof value.active==='boolean')active=value.active;}catch{/* scalar diagnostic only */}
          }
          observeNativeTransport(request,endpoint,'json-response',signal,response.status,undefined,active);
        },error=>observeNativeTransport(request,endpoint,'json-error',signal,response.status,error));
        return result;
      }});
    } catch(error){observeNativeTransport(request,endpoint,'json-observer-error',signal,response.status,error);}
  },error=>observeNativeTransport(request,endpoint,'fetch-error',signal,undefined,error));
  return promise;
}}) : null;
const web = native ? null : createWebBootstrap();
if (web) {
  const open = web.driver.openScope.bind(web.driver);
  web.driver.openScope = async (proof,signal) => {
    const ports = await open(proof,signal);
    // Mutable observation delegates retain the actual gated receivers. The production
    // BootstrapSession still creates its own sessions/binding from these genuine ports.
    const repository = Object.fromEntries(Object.entries(ports.repository).map(([name,value]) =>
      [name,typeof value==='function' ? value.bind(ports.repository) : value])) as ContentRepository;
    return {...ports,repository};
  };
}
const bootstrap = desktop?.session ?? web!.session;
const active = () => {const runtime=bootstrap.getActiveRuntime();if(!runtime)throw new Error('composition-active-runtime-required');return runtime;};
const deliveryTimeline: unknown[] = [];
const flushTimingEvidence:unknown[]=[];
const httpSnapshot=():FixtureTimingSnapshot=>(window as unknown as {fixtureDriveTimings?:()=>FixtureTimingSnapshot}).fixtureDriveTimings?.()??{sequence:0,entries:[]};
const spanSummary=(before:FixtureTimingSnapshot,after:FixtureTimingSnapshot,start:number,end:number)=>{
  const priorOpen=before.entries.filter(value=>value.finished===undefined),bySequence=new Map(after.entries.map(value=>[value.sequence,value]));
  const added=after.entries.filter(value=>value.sequence>before.sequence);
  const lostNew=Math.max(0,after.sequence-before.sequence-added.length),lostOpen=priorOpen.filter(value=>!bySequence.has(value.sequence)).length;
  const spans=[...new Map([...priorOpen,...added,...after.entries.filter(value=>value.started<=start&&(value.finished??end)>=start)].map(value=>[value.sequence,bySequence.get(value.sequence)??value])).values()];
  const intervals:[number,number][]=[],categories:Record<string,{count:number;totalMs:number;maxMs:number;ongoing:number;mutations:Record<string,number>}>={};
  for(const span of spans){const a=Math.max(start,span.started),b=Math.min(end,span.finished??end);if(b<a)continue;intervals.push([a,b]);
    const key=span.method+':'+span.category,value=categories[key]??={count:0,totalMs:0,maxMs:0,ongoing:0,mutations:{}};value.count++;value.totalMs+=b-a;value.maxMs=Math.max(value.maxMs,b-a);if(span.finished===undefined)value.ongoing++;
    for(const [kind,count] of Object.entries(span.mutations??{}))value.mutations[kind]=(value.mutations[kind]??0)+count;
  }
  return {count:spans.length,lostNew,lostOpen,complete:lostNew===0&&lostOpen===0,categories,intervals};
};
const unionMs=(intervals:[number,number][])=>{let total=0,a=0,b=0;for(const [start,end] of [...intervals].sort((x,y)=>x[0]-y[0])){if(start>b){total+=b-a;a=start;b=end;}else b=Math.max(b,end);}return total+b-a;};

let deliveryInvocation = 0;
const deliveryPhase = (call: number, phase: string, targetId?: string) => {
  deliveryTimeline.push({ call, phase, targetId, at: performance.now() });
  if (deliveryTimeline.length > 96) deliveryTimeline.shift();
};
const replicationLabels=new WeakMap<object,number>(); let replicationLabelSequence=0;
const replicationLabel=(owner:object|undefined)=>{if(!owner)return null;let value=replicationLabels.get(owner);if(value===undefined){value=++replicationLabelSequence;replicationLabels.set(owner,value);}return value;};
const observed = new WeakSet<LibraryRuntime>();
bootstrap.subscribe(() => {
  const runtime=bootstrap.getActiveRuntime();
  if (runtime && !observed.has(runtime)) { observed.add(runtime);config.scope=runtime.proof.scope;installObservers(runtime); }
});
const BrowserDocument = lazy(()=>import('../../src/adapters/browser/DocumentLibraryView').then(value=>({default:value.BrowserDocumentLibrary})));
const BrowserMarkdown = lazy(()=>import('../../src/adapters/browser/MarkdownLibraryView').then(value=>({default:value.BrowserMarkdownLibrary})));
const renderDocument = (binding:DocumentLibraryBinding) => <BrowserDocument binding={binding}/>;
const renderMarkdown = (binding:DocumentLibraryBinding) => <BrowserMarkdown binding={binding}/>;
let root = createRoot(document.getElementById('root')!);
const render = () => root.render(<StrictMode>{desktop ? <DesktopBootstrapApp host={desktop}/> :
  <Suspense fallback={<p role="status">Loading composition</p>}><BootstrapConnection session={bootstrap} renderDocument={renderDocument} renderMarkdown={renderMarkdown}/></Suspense>}</StrictMode>);
render();
Object.assign(window,{
  compositionBootstrapStatus: () => ({state:bootstrap.getSnapshot(),provider:bootstrap.getProviderConnection()?.getSnapshot(),scope:bootstrap.getActiveRuntime()?.proof.scope}),
  compositionVisibleMarkdownEditorText: (id: string) => {
    if(typeof id!=='string'||!id)throw new Error('fixture-editor-document-id-required');
    const visible=(element:HTMLElement)=>element.isConnected && [...element.getClientRects()].some(rect=>rect.width>0&&rect.height>0)
      && getComputedStyle(element).visibility!=='hidden' && !element.closest('[hidden], [inert], [aria-hidden="true"]');
    const roots=[...document.querySelectorAll<HTMLElement>('[data-content-document]')].filter(element=>element.getAttribute('data-content-document')===id&&visible(element));
    if(roots.length!==1)throw new Error('fixture-exact-visible-document-required');
    const root=roots[0], editors=[...root.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"]')].filter(element=>visible(element)&&element.closest('[data-content-document]')===root);
    if(editors.length!==1)throw new Error('fixture-exact-visible-markdown-editor-required');
    const element=editors[0], view=EditorView.findFromDOM(element);
    if(!view||view.contentDOM!==element||!view.dom.isConnected||view.dom.closest('[data-content-document]')!==root)throw new Error('fixture-editor-view-owner-mismatch');
    return view.state.doc.toString();
  },
  compositionAdmittedPeer: () => active().resources.peerId,
  compositionPendingIntentCount: async () => {
    const runtime = active(), pending = await runtime.binding.repository.pendingIntents();
    if (bootstrap.getActiveRuntime() !== runtime) throw new Error('fixture-runtime-changed-during-pending-intent-read');
    return pending.length;
  },
  compositionSeedBase: async () => {const runtime=active(),read=await runtime.binding.repository.read(runtime.proof.scope.libraryId);
    return {scope:runtime.proof.scope,root:read.checkpoint.root as LibrarySnapshot,head:read.heads[0]};},
  compositionConfigure: (value:Pick<typeof config,'documentId'|'contentKind'|'seededContents'>) => {Object.assign(config,value);},
  compositionRepository: async (method:keyof ContentRepository,args:unknown[]) => {
    const repository=active().binding.repository;
    if (method==='scope') return repository.scope;
    if (!['read','readIntent','pendingRecords','receipt','storeResource','readResource','publish','commit'].includes(method))
      throw new Error('fixture-public-repository-operation-denied');
    if(method==='storeResource'){
      const value=args[0] as {id:string;sha256:string;mediaType:string;bytes:number[];expected?:ResourceMetadata};
      return repository.storeResource({...value,bytes:Uint8Array.from(value.bytes)});
    }
    if(method==='readResource'){
      const value=await repository.readResource(args[0] as string);return value?{...value,bytes:Array.from(value.bytes)}:undefined;
    }
    const action=repository[method] as (...values:unknown[])=>Promise<unknown>;return action.apply(repository,args);
  },
  compositionSeedResource: async (metadata:ResourceMetadata,bytes:number[]) => active().binding.repository.storeResource({...metadata,bytes:Uint8Array.from(bytes),expected:metadata}),
  compositionSeedPublication: (publication:ContentPublication) => active().binding.repository.publish(publication),
  compositionWaitForReplicationIdle: async (remaining:number) => {
    if(!Number.isFinite(remaining)||remaining<=0||remaining>30000)throw new Error('invalid delivery idle deadline');
    const runtime=active(),replication=runtime.binding.replication;
    await new Promise<void>((resolve,reject)=>{
      let settled=false,release:(()=>void)|undefined;
      const finish=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);release?.();if(error!==undefined)reject(error);else resolve();};
      const check=()=>{try{if(active()!==runtime||runtime.binding.replication!==replication)throw new Error('delivery runtime changed');const state=replication.getSnapshot();if(state.error)throw new Error(state.error);if(!state.running)finish();}catch(error){finish(error);}};
      const timer=setTimeout(()=>finish(new Error('exact durable provider delivery deadline exceeded')),remaining);
      try{release=replication.subscribe(check);if(settled)release();else check();}catch(error){finish(error);}
    });
  },
  compositionDelivery: async (expected:{batchId:string;targetId:string}[],mode:'full'|'observe'='full') => {
    if(mode!=='full'&&mode!=='observe')throw new Error('invalid delivery observation mode');
    const runtime=active(),repository=runtime.binding.repository,call=++deliveryInvocation;
    if(mode==='full'){
    const flushStarted=performance.now(),httpBefore=measureFlush&&!native?httpSnapshot():undefined,planBefore=measureFlush&&!native?planSnapshot():undefined;
    deliveryPhase(call,'flush-start');
    try{await runtime.binding.replication.flush();deliveryPhase(call,'flush-completed');}
    finally{if(measureFlush&&!native){const ended=performance.now(),http=spanSummary(httpBefore!,httpSnapshot(),flushStarted,ended),plan=spanSummary(planBefore!,planSnapshot(),flushStarted,ended);
      const httpUnionMs=unionMs(http.intervals),planUnionMs=unionMs(plan.intervals),combinedUnionMs=unionMs([...http.intervals,...plan.intervals]);
      const summary={host:'web',call,flushMs:ended-flushStarted,http:{...http,intervals:undefined,unionMs:httpUnionMs},plan:{...plan,intervals:undefined,unionMs:planUnionMs},overlapMs:httpUnionMs+planUnionMs-combinedUnionMs,outsideBothMs:Math.max(0,ended-flushStarted-combinedUnionMs),scope:'Mock HTTP includes browser binding/serialization; plan spans include validation/cloning/IDB. Incomplete or ongoing spans do not establish exclusive physical I/O time.'};
      flushTimingEvidence.push(summary);if(flushTimingEvidence.length>32)flushTimingEvidence.shift();console.info('composition-flush-timing:'+JSON.stringify(summary));
    }}
    }
    const actualReads=new Map<string,Promise<RepositoryState>>();
    const readTarget=(targetId:string)=>{
      let read=actualReads.get(targetId);
      if(!read){read=repository.read(targetId);actualReads.set(targetId,read);}
      return read;
    };
    const targets=[...new Set(expected.map(value=>value.targetId))];
    const [reads]=await Promise.all([
      Promise.all(targets.map(async targetId=>{
        const anchor=expected.find(value=>value.targetId===targetId)!;
        deliveryPhase(call,'receipt-probe-start',targetId);const present=await repository.receipt(anchor.batchId);deliveryPhase(call,'receipt-probe-completed',targetId);
        if(!present||present.id!==anchor.batchId||present.targetId!==targetId||present.durable!==true)return [targetId,undefined] as const;
        deliveryPhase(call,'receipt-read-start',targetId);const read=await readTarget(targetId);deliveryPhase(call,'receipt-read-completed',targetId);
        return [targetId,read] as const;
      })),
      (async()=>{
        if(mode==='observe')return;
        deliveryPhase(call,'library-refresh-start');await runtime.binding.sessions.getLibrary().refresh();deliveryPhase(call,'library-refresh-completed');
        const target=runtime.navigation.getSnapshot().documentId;
        const selectedItem=runtime.binding.sessions.getLibrary().getSnapshot().items.find(item=>item.id===target);
        if(target&&selectedItem?.kind!=='attachment'){
          const selectedKind=selectedItem?.kind;let isMarkdown:boolean;
          if(selectedKind==='markdown'||selectedKind==='pdf'||selectedKind==='notebook'){
            // Existing catalog item kinds cannot be rebound; refresh still owns content validation.
            isMarkdown=selectedKind==='markdown';
          }else{
            // A deleted/current target can be absent from active items. Preserve its actual read.
            deliveryPhase(call,'kind-read-start',target);const read=await readTarget(target);deliveryPhase(call,'kind-read-completed',target);
            isMarkdown=read.checkpoint.root.kind==='markdown';
          }
          deliveryPhase(call,'session-refresh-start',target);
          if(isMarkdown)await runtime.binding.sessions.getMarkdown(target).refresh();else await runtime.binding.sessions.get(target).refresh();
          deliveryPhase(call,'session-refresh-completed',target);
        }
      })(),
    ]);
    const byTarget=new Map(reads);
    deliveryPhase(call,'pending-read-start');const pending=await repository.pendingRecords();deliveryPhase(call,'pending-read-completed');
    return {pending,peerId:runtime.resources.peerId,
      receipts:expected.map(({batchId,targetId})=>byTarget.get(targetId)?.receipts.find(receipt=>receipt.id===batchId&&receipt.targetId===targetId)),
      replication:runtime.binding.replication.getSnapshot()};
  },
  compositionClose: () => bootstrap.close(),
  compositionUnmount: () => root.unmount(),
  compositionRemount: () => {root=createRoot(document.getElementById('root')!);render();},
});

// Labels remain unique across runtime replacement within this page.
const markdownSessionWitnessIds = new WeakMap<object, string>();
const markdownEditorWitnessIds = new Map<symbol, string>();
let markdownWitnessSequence = 0;
// B13-g read-only test hook: how many times the content navigation session has published a new state (every start and end of an attempt does).
// It lets a test tell that an attempt really started and finished, instead of reading an error left over from an earlier attempt.
let navigationRevision = 0;
Object.assign(window, { compositionNavigationRevision: () => navigationRevision });
function installObservers(runtime:LibraryRuntime) {
runtime.navigation.subscribe(() => { navigationRevision++; });
const repository=runtime.binding.repository,sessions:DocumentEditSessions=runtime.binding.sessions;
const replication={getSnapshot:()=>runtime.binding.replication.getSnapshot(),flush:()=>runtime.binding.replication.flush()};
// Read-only startup diagnostics. Wrappers return the authority's original
// promise and preserve its arguments, results and exceptions.
const startupTrace: unknown[] = [];
const startupDiagnostics = new URLSearchParams(location.search).get('startupDiagnostics') === '1';
let startupSequence = 0, lifecycleGeneration = 0;
const trace = (event: string, detail: unknown) => {
  if (!startupDiagnostics) return;
  startupTrace.push({ sequence: ++startupSequence, at: performance.now(), event, lifecycleGeneration, detail });
  if (startupTrace.length > 2000) startupTrace.shift();
};
const messageChannels: { id: number; posted: number; received: number; lastPost: number; lastReceive: number; caller: string }[] = [];
if (startupDiagnostics) {
  window.MessageChannel = new Proxy(window.MessageChannel, { construct(target, args, newTarget) {
    const channel = Reflect.construct(target, args, newTarget) as MessageChannel;
    const counter = { id: messageChannels.length, posted: 0, received: 0, lastPost: 0, lastReceive: 0, caller: new Error().stack ?? '' };
    messageChannels.push(counter);
    // Counters retain neither port nor channel. Original React onmessage and
    // postMessage payload/order remain intact; no start/close is invoked.
    channel.port1.addEventListener('message', () => { counter.received++; counter.lastReceive = performance.now(); });
    const post = channel.port2.postMessage.bind(channel.port2);
    channel.port2.postMessage = (message: unknown, options?: Transferable[] | StructuredSerializeOptions) => {
      counter.posted++; counter.lastPost = performance.now();
      if (Array.isArray(options)) return post(message, options);
      return post(message, options);
    };
    return channel;
  } });
}
const addWindowListener = window.addEventListener.bind(window), removeWindowListener = window.removeEventListener.bind(window);
if (startupDiagnostics) {
window.addEventListener = (...args: Parameters<typeof window.addEventListener>) => {
  if (args[0] === 'pagehide') {
    const caller = new Error().stack ?? '';
    if (caller.includes('/DocumentLibraryConnection.tsx:')) trace('connection.layout.setup', { caller });
  }
  return addWindowListener(...args);
};
window.removeEventListener = (...args: Parameters<typeof window.removeEventListener>) => {
  if (args[0] === 'pagehide') {
    const caller = new Error().stack ?? '';
    if (caller.includes('/DocumentLibraryConnection.tsx:')) trace('connection.layout.cleanup', { caller });
  }
  return removeWindowListener(...args);
};
}
for (const name of ['pagehide', 'pageshow'] as const) window.addEventListener(name, event => {
  lifecycleGeneration++; trace(name, { persisted: event.persisted });
});
const annotationPointerTrace: unknown[] = [];
for (const name of ['pointerdown', 'pointerup', 'pointercancel'] as const) window.addEventListener(name, event => {
  const layer = event.target instanceof Element ? event.target.closest('[data-annotation-layer]') : null;
  if (!layer) return;
  annotationPointerTrace.push({ name, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId,
    pointerType: event.pointerType, bounds: layer.getBoundingClientRect().toJSON() });
  if (annotationPointerTrace.length > 40) annotationPointerTrace.shift();
}, { capture: true });
const inkPointerTrace: unknown[] = [], activeInkPointers = new Set<number>();
const inkLayerSelector = '[aria-label="PDF\u66f8\u304d\u8fbc\u307f\u30ec\u30a4\u30e4\u30fc"]';
const inkContactEnvironment = () => ({ at: performance.now(), focused: document.hasFocus(), visibility: document.visibilityState,
  viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, activePointerIds: [...activeInkPointers],
  activeElement: document.activeElement && { tag: document.activeElement.tagName, label: document.activeElement.getAttribute('aria-label') } });
const recordInkContact = (value: unknown) => { inkPointerTrace.push(value); if (inkPointerTrace.length > 64) inkPointerTrace.shift(); };
for (const name of ['pointerdown', 'pointerup', 'pointercancel'] as const) window.addEventListener(name, event => {
  const target = event.target instanceof Element ? event.target : null, layer = target?.closest(inkLayerSelector);
  if (name === 'pointerdown' && layer) {
    if (activeInkPointers.size >= 32) activeInkPointers.delete(activeInkPointers.values().next().value!);
    activeInkPointers.add(event.pointerId);
  }
  if (!layer && !activeInkPointers.has(event.pointerId)) return;
  recordInkContact({ name, ...inkContactEnvironment(), eventTimeStamp: event.timeStamp, pointerId: event.pointerId,
    pointerType: event.pointerType, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY,
    target: target && { tag: target.tagName, label: target.getAttribute('aria-label') }, bounds: layer?.getBoundingClientRect().toJSON() ?? null });
  if (name !== 'pointerdown') activeInkPointers.delete(event.pointerId);
}, { capture: true, passive: true });
for (const name of ['blur', 'resize'] as const) window.addEventListener(name, event => {
  recordInkContact({ name, ...inkContactEnvironment(), eventTimeStamp: event.timeStamp });
}, { capture: true, passive: true });
const repositoryHeads = new Map<string, readonly string[]>();
type AnnotationPreflightTiming = { id: string; captured: boolean; completed: boolean; released: boolean; caller: string;
  wait: Promise<void>; release(): void };
let annotationPreflightTiming: AnnotationPreflightTiming | null = null;
type AnnotationLocationTiming = { id: string; captured: boolean; completed: boolean; released: boolean;
  ambientRefreshStarts: number; guardedGeneration: number | null; ambientGenerations: number[];
  wait: Promise<void>; release(): void };
let annotationLocationTiming: AnnotationLocationTiming | null = null;
let annotationLocationReadActor: string | null = null;
const read = repository.read.bind(repository);
repository.read = async id => {
  const call = ++startupSequence;
  if (startupDiagnostics) trace('repository.read.start', { call, id, caller: new Error().stack });
  const pending = annotationPreflightTiming;
  const caller = pending?.id === id && !pending.captured && !pending.released ? new Error().stack ?? '' : '';
  // One actual save-preflight read only. Catalog/corpus reads of this same
  // document must continue so ordinary replication can adopt a remote deletion.
  const held = pending?.id === id && !pending.captured && !pending.released && caller.includes('commitAnnotationDraft') ? pending : null;
  if (held) { held.captured = true; held.caller = caller; }
  const location = annotationLocationTiming;
  const heldLocation = location?.id === id && !location.captured && !location.released && annotationLocationReadActor === id ? location : null;
  if (heldLocation) heldLocation.captured = true;
  let result: Awaited<ReturnType<typeof read>>;
  try { result = await read(id); }
  catch (error) { trace('repository.read.error', { call, id, error: String(error) }); throw error; }
  repositoryHeads.set(id, [...result.heads]);
  trace('repository.read.settled', { call, id, heads: result.heads });
  if (held) { held.completed = true; await held.wait; }
  if (heldLocation) { heldLocation.completed = true; await heldLocation.wait; }
  return result;
};
const readIntent = repository.readIntent.bind(repository);
if (startupDiagnostics) {
repository.readIntent = id => {
  const call = ++startupSequence;
  trace('repository.readIntent.start', { call, id, caller: new Error().stack });
  const result = readIntent(id);
  void result.then(value => trace('repository.readIntent.settled', { call, id, present: !!value }),
    error => trace('repository.readIntent.error', { call, id, error: String(error) }));
  return result;
};
}
const resourceReadCounts: Record<string, number> = {};
  const heldResourceReads = new Map<string, { wait: Promise<void>; release(): void }>();
const readResource = repository.readResource.bind(repository);
  repository.readResource = async id => {
  resourceReadCounts[id] = (resourceReadCounts[id] ?? 0) + 1;
    const held = heldResourceReads.get(id); if (held) await held.wait;
  return readResource(id);
};
const observedDocuments = new Map<string, ReturnType<typeof sessions.get>>();
const observedMarkdown = new Map<string, ReturnType<typeof sessions.getMarkdown>>();
const getDocument = sessions.get.bind(sessions), getMarkdown = sessions.getMarkdown.bind(sessions);
const initializeSessions = sessions.initialize.bind(sessions);
if (startupDiagnostics) {
sessions.initialize = () => {
  const call = ++startupSequence;
  trace('registry.initialize.start', { call, state: sessions.getSnapshot(), caller: new Error().stack });
  const result = initializeSessions();
  void result.then(() => trace('registry.initialize.settled', { call, state: sessions.getSnapshot() }),
    error => trace('registry.initialize.error', { call, error: String(error) }));
  return result;
};
sessions.subscribe(() => trace('registry.state', sessions.getSnapshot()));
}
const tracedDocuments = new WeakSet<ReturnType<typeof sessions.get>>();
const locationTimedDocuments = new WeakSet<ReturnType<typeof sessions.get>>();
function lazyStartupEvidence(component: unknown) {
  const payload = (component as { _payload?: { _status?: number; _result?: unknown } })._payload;
  return { status: payload?._status, resultType: payload ? typeof payload._result : undefined };
}
function reactStartupEvidence(failureOnly = false) {
  // Private fields are observed only in the diagnostic fixture. No React
  // callback, queue, promise, root or hook is invoked or changed here.
  const container = document.getElementById('root') as (HTMLElement & Record<string, unknown>) | null;
  const key = container && Object.keys(container).find(value => value.startsWith('__reactContainer$'));
  const host = (key ? container?.[key] : undefined) as { stateNode?: Record<string, unknown> } | undefined;
  const root = host?.stateNode;
  type LazyType = { _payload?: { _status?: number; _result?: unknown } };
  type Fiber = { tag: number; type?: { name?: string }; elementType?: LazyType;
    child?: Fiber; sibling?: Fiber; memoizedState?: unknown; flags: number; lanes: number; childLanes: number;
    alternate?: Fiber; updateQueue?: unknown; _debugThenableState?: unknown; memoizedProps?: { children?: unknown } };
  const fibers: unknown[] = [];
  const visit = (fiber: Fiber | undefined, depth: number, tree: string) => {
    if (!fiber || fibers.length > 200) return;
    const name = fiber.type?.name;
    if (name || [13, 16, 22].includes(fiber.tag)) {
      const hooks: unknown[] = [];
      if (name === 'DocumentLibraryState' || name === 'LibraryContentState') {
        let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
        for (let index = 0; hook && index < 100; index++, hook = hook.next as typeof hook) {
          const ref = hook.memoizedState as { current?: { active?: boolean; generation?: number } } | null;
          if (ref?.current && typeof ref.current.active === 'boolean' && typeof ref.current.generation === 'number') {
            const adjacentBooleanRefs: (boolean | null)[] = []; let adjacent=hook.next as typeof hook;
            for(let offset=0;adjacent && offset<2;offset++,adjacent=adjacent.next as typeof hook){ const value=(adjacent.memoizedState as {current?:unknown}|null)?.current; adjacentBooleanRefs.push(typeof value==='boolean'?value:null); }
            hooks.push({ index, active:ref.current.active, generation:ref.current.generation, adjacentBooleanRefs });
          }
          if (ref?.current && typeof (ref.current as {then?:unknown}).then==='function') hooks.push({index,promiseRef:true});
        }
      }
      const payload = fiber.elementType?._payload;
      // The inner fallback has no committed lazy fiber. Inspect its actual
      // Suspense child element's type without initializing or calling it.
      const element = failureOnly && fiber.tag === 13 && fiber.memoizedProps?.children && !Array.isArray(fiber.memoizedProps.children)
        ? fiber.memoizedProps.children as { type?: unknown } : undefined;
      const childType = element?.type;
      const childLazy = childType && typeof childType === 'object' ? childType as LazyType : undefined;
      const childPayload = childLazy?._payload;
      const childResult = childPayload?._status === 1 && childPayload._result && typeof childPayload._result === 'object'
        ? childPayload._result as { default?: unknown } : undefined;
      const defaultName = typeof childResult?.default === 'function' ? childResult.default.name.slice(0, 80) : undefined;
      fibers.push({ tree, depth, tag: fiber.tag, name, flags: fiber.flags, lanes: fiber.lanes, childLanes: fiber.childLanes,
        suspense: fiber.tag === 13 ? { pending: fiber.memoizedState != null } : undefined,
        suspenseChild: failureOnly && fiber.tag === 13 ? { origin: 'fiber.memoizedProps.children.type', type: typeof childType,
          ...(childLazy ? lazyStartupEvidence(childLazy) : {}), defaultName } : undefined,
        lazyStatus: payload?._status, lazyResultType: payload ? typeof payload._result : undefined,
        debugThenables: fiber._debugThenableState ? String(fiber._debugThenableState) : undefined, hooks });
    }
    visit(fiber.child, depth + 1, tree); visit(fiber.sibling, depth, tree);
  };
  const current = root?.current as Fiber | undefined;
  visit(current, 0, 'current'); visit(current?.alternate, 0, 'alternate');
  const callback = root?.callbackNode as { id?: number; callback?: unknown; priorityLevel?: number; startTime?: number; expirationTime?: number } | null;
  const wanted = ['/src/adapters/desktop/DocumentLibraryView', '/src/features/reader/DocumentLibraryConnection', '/src/adapters/browser/DocumentLibraryView'];
  const resources = failureOnly ? performance.getEntriesByType('resource').flatMap(entry => {
    const value = entry as PerformanceResourceTiming;
    let pathname: string;
    try { pathname = new URL(value.name, location.href).pathname; } catch { return []; }
    const selected = wanted.find(item => pathname === item || pathname === item + '.ts' || pathname === item + '.tsx');
    if (!selected || value.responseEnd <= 0) return [];
    return [{ path: selected, startTime: value.startTime, responseEnd: value.responseEnd, duration: value.duration }];
  }).slice(-12) : undefined;
  return { visibility: document.visibilityState, focus: document.hasFocus(), clock: failureOnly ? { performanceNow: performance.now(), timeOrigin: performance.timeOrigin, dateNow: Date.now() } : undefined, resources,
    root: root ? { pendingLanes: root.pendingLanes, suspendedLanes: root.suspendedLanes, pingedLanes: root.pingedLanes,
      warmLanes: root.warmLanes, callbackPriority: root.callbackPriority, timeoutHandle: root.timeoutHandle,
      cancelPendingCommit: !!root.cancelPendingCommit, expiredLanes: root.expiredLanes,
      callback: callback ? { id: callback.id, callback: typeof callback.callback, priorityLevel: callback.priorityLevel,
        startTime: callback.startTime, expirationTime: callback.expirationTime } : null } : null, fibers };
}
const libraryObservationId = crypto.randomUUID();
let observedLibrary: ReturnType<typeof sessions.getLibrary> | undefined;
let observedAnnotationBrowser: ReturnType<typeof sessions.getAnnotationBrowser> | undefined;
const getLibrary = sessions.getLibrary.bind(sessions);
const getAnnotationBrowser = sessions.getAnnotationBrowser.bind(sessions);
sessions.getLibrary = () => { const session = getLibrary(); observedLibrary = session; return session; };
sessions.getAnnotationBrowser = () => { const session = getAnnotationBrowser(); observedAnnotationBrowser = session; return session; };
sessions.get = id => {
  const session = getDocument(id); observedDocuments.set(id, session);
  if (!locationTimedDocuments.has(session)) {
    locationTimedDocuments.add(session);
    const refresh = session.refresh.bind(session);
    session.refresh = (...args) => {
      const previousActor = annotationLocationReadActor;
      if (args[1]) annotationLocationReadActor = id;
      const timing = annotationLocationTiming?.id === id && !annotationLocationTiming.released ? annotationLocationTiming : null;
      const ambient = !args[1] && !!timing?.captured;
      try {
        // Synchronous actor identification only. Return the original promise;
        // no settlement/rejection handler is attached in ordinary acceptance.
        const result = refresh(...args);
        const generation = (session as unknown as { readGeneration: number }).readGeneration;
        if (timing && args[1] && timing.captured) timing.guardedGeneration = generation;
        if (timing && ambient) { timing.ambientRefreshStarts++; timing.ambientGenerations.push(generation); }
        return result;
      } finally { annotationLocationReadActor = previousActor; }
    };
  }
  if (startupDiagnostics && !tracedDocuments.has(session)) {
    tracedDocuments.add(session);
    const state = () => ({ generation: (session as unknown as { readGeneration: number }).readGeneration,
      registry: sessions.getSnapshot(), ready: session.getSnapshot().ready, heads: session.getSnapshot().heads,
      error: session.getSnapshot().error, phase: session.getSnapshot().phase, canNavigate: session.canNavigate() });
    trace('document.observed', { id, state: state() });
    const refresh = session.refresh.bind(session);
    session.refresh = (...args) => {
      const call = ++startupSequence;
      trace('document.refresh.start', { call, id, preferred: args[0], guarded: !!args[1], state: state(), caller: new Error().stack });
      const result = refresh(...args);
      trace('document.refresh.returned', { call, id, state: state() });
      void result.then(value => trace('document.refresh.settled', { call, id, value, state: state() }),
        error => trace('document.refresh.error', { call, id, error: String(error), state: state() }));
      return result;
    };
    session.subscribe(() => trace('document.state', { id, state: state() }));
  }
  return session;
};
sessions.getMarkdown = id => { const session = getMarkdown(id); observedMarkdown.set(id, session); return session; };
const documentLibrary = runtime.binding;
// Read-only observations plus ordinary external transport delivery. No editor/session mutation is exposed.
Object.assign(window, {
  compositionMarkdownEvidence: async () => ({ state: await repository.read(config.documentId), pending: await repository.pendingRecords(),
    session: sessions.getMarkdown(config.documentId).getSnapshot(), leave: await sessions.prepareLeave() }),
  compositionMarkdownDiagnostics: () => ({ session: sessions.getMarkdown(config.documentId).getSnapshot(), replication: replication.getSnapshot(), registry: sessions.getSnapshot() }),
});
Object.assign(window, { compositionEvidence: async () => ({ state: await repository.read(config.documentId),
  pending: await repository.pendingRecords(), session: sessions.get(config.documentId).getSnapshot() }),
  compositionDiagnostics: () => ({ session: sessions.get(config.documentId).getSnapshot(), replication: replication.getSnapshot(), registry: sessions.getSnapshot() }) });
Object.assign(window, { compositionFailureRenderEvidence: () => ({ react: reactStartupEvidence(true), lazy: { document: lazyStartupEvidence(BrowserDocument), markdown: lazyStartupEvidence(BrowserMarkdown) } }),
  compositionDeliver: () => replication.flush(), compositionScratchQuota: (fail: boolean) => { scratchQuota = fail; },
  compositionStartupEvidence: () => ({ configuredDocumentId: config.documentId,
    nativeTransport: measureFlush && native ? nativeTransportSnapshot() : undefined,
    controlledSync: startupDiagnostics ? (()=>{
      const current=bootstrap.getActiveRuntime(), host=bootstrap.getSnapshot(), registry=runtime.binding.sessions.getSnapshot();
      const documentId=document.querySelector('[data-content-document]')?.getAttribute('data-content-document')??null;
      const session=documentId?observedDocuments.get(documentId):undefined, state=session?.getSnapshot();
      const surfaces=Object.values(state?.surfaces??{}), owner=current?.binding.replication;
      const react=reactStartupEvidence() as {fibers?:{tree?:string;name?:string;hooks?:unknown[]}[]};
      return {capturedEpochMs:Date.now(),host:{phase:host.phase,locked:host.locked,error:host.error.slice(0,256)},activeRuntime:!!current,sameRuntime:current===runtime,sameBinding:current?.binding===runtime.binding,
        registry:{ready:registry.ready,active:registry.active,error:registry.error.slice(0,256)},documentId,
        document:state&&{ready:state.ready,phase:state.phase,inputActive:state.inputActive,canNavigate:session?.canNavigate(),annotationDrafts:surfaces.filter(value=>!!value.annotationDraft).length,textDrafts:surfaces.filter(value=>!!value.textDraft).length},
        owner:{active:replicationLabel(owner),retained:replicationLabel(runtime.binding.replication),same:owner===runtime.binding.replication},replication:owner?.getSnapshot(),
        currentReact:(react.fibers??[]).filter(value=>value.tree==='current'&&value.name==='DocumentLibraryState').slice(0,3).map(value=>({name:value.name,hooks:value.hooks?.slice(0,12)}))};
    })() : undefined,
    library: startupDiagnostics ? (() => { const state=observedLibrary?.getSnapshot(); return state && { ready:state.ready, busy:state.busy, error:state.error.slice(0,256), selectedVersion:state.selectedVersion, heads:[...state.heads], items:state.items.length, deletedItems:state.deletedItems.length }; })() : undefined,
    inkSettings: runtime.binding.inkSettings.getSnapshot(),
    deliveryTimeline: [...deliveryTimeline], flushTimingEvidence:[...flushTimingEvidence],
    currentTimings: measureFlush && !native ? { capturedAt: performance.now(), plan: planSnapshot(), http: httpSnapshot() } : undefined,
    inkPointerTrace: [...inkPointerTrace], activeInkPointerIds: [...activeInkPointers],
    actualDocumentId: document.querySelector('[data-content-document]')?.getAttribute('data-content-document') ?? null,
    observedDocuments: [...observedDocuments.keys()], repositoryHeads: Object.fromEntries(repositoryHeads), trace: [...startupTrace],
    react: startupDiagnostics ? reactStartupEvidence() : undefined,
    lazy: startupDiagnostics ? { document: lazyStartupEvidence(BrowserDocument), markdown: lazyStartupEvidence(BrowserMarkdown) } : undefined, messageChannels }),
  compositionAnnotationPointerEvidence: () => [...annotationPointerTrace],
  // Timing at a real repository port; this never changes read results, edit
  // admission, callbacks, validation, journal writes or transport semantics.
  compositionHoldAnnotationPreflightRead: (id: string) => {
    if (annotationPreflightTiming && !annotationPreflightTiming.released) throw new Error('annotation-preflight-read-already-held');
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    annotationPreflightTiming = { id, captured: false, completed: false, released: false, caller: '', wait, release };
  },
  compositionAnnotationPreflightTiming: () => !annotationPreflightTiming ? null : ({ id: annotationPreflightTiming.id,
    captured: annotationPreflightTiming.captured, completed: annotationPreflightTiming.completed,
    released: annotationPreflightTiming.released, caller: annotationPreflightTiming.caller }),
  compositionReleaseAnnotationPreflightRead: () => {
    if (annotationPreflightTiming) { annotationPreflightTiming.released = true; annotationPreflightTiming.release(); }
  },
  compositionReadIntent: (id: string) => repository.readIntent(id),
  compositionHoldAnnotationLocationRead: (id: string) => {
    if (annotationLocationTiming && !annotationLocationTiming.released) throw new Error('annotation-location-read-already-held');
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    annotationLocationTiming = { id, captured: false, completed: false, released: false, ambientRefreshStarts: 0,
      guardedGeneration: null, ambientGenerations: [], wait, release };
  },
  compositionAnnotationLocationTiming: () => !annotationLocationTiming ? null : ({ id: annotationLocationTiming.id,
    captured: annotationLocationTiming.captured, completed: annotationLocationTiming.completed, released: annotationLocationTiming.released,
    ambientRefreshStarts: annotationLocationTiming.ambientRefreshStarts, guardedGeneration: annotationLocationTiming.guardedGeneration,
    ambientGenerations: [...annotationLocationTiming.ambientGenerations] }),
  compositionReleaseAnnotationLocationRead: () => {
    if (annotationLocationTiming) { annotationLocationTiming.released = true; annotationLocationTiming.release(); }
  },
  compositionAnnotationBrowserEvidence: () => observedAnnotationBrowser?.getSnapshot(),
  compositionLibraryMemory: () => {
    const registry = sessions.getSnapshot(), library = observedLibrary;
    if (bootstrap.getActiveRuntime() !== runtime || !registry.ready || !registry.active || !library) return null;
    const session = library.getSnapshot(), selected = library.getSelectedSnapshot();
    return { identity: libraryObservationId, session, selected };
  },
  compositionLibraryWitness: async (identity: string, version: string) => {
    const library = observedLibrary;
    const valid = () => {
      const registry = sessions.getSnapshot(), state = library?.getSnapshot(), selected = library?.getSelectedSnapshot();
      return identity === libraryObservationId && bootstrap.getActiveRuntime() === runtime && observedLibrary === library
        && !!library && registry.ready && registry.active && state?.selectedVersion === version && selected?.version === version
        && config.scope.libraryId === repository.scope.libraryId;
    };
    if (!valid()) throw new Error('library-observation-owner-or-version-changed');
    const state = await repository.read(config.scope.libraryId);
    const pending = await repository.pendingRecords();
    if (!valid()) throw new Error('library-observation-owner-or-version-changed');
    return { state, session: library!.getSnapshot(), selected: library!.getSelectedSnapshot(), pending, replication: replication.getSnapshot() };
  },
  compositionLibraryEvidence: async () => {
    let phase:'read'|'pending'='read';
    try {
      const state=await repository.read(config.scope.libraryId),session=observedLibrary?.getSnapshot();
      phase='pending'; const pending=await repository.pendingRecords();
      return {state,session,pending,replication:replication.getSnapshot()};
    } catch(error) {
      if(startupDiagnostics)trace('library-evidence.error',{phase,name:(error instanceof Error?error.name:typeof error).slice(0,80),message:(error instanceof Error?error.message:String(error)).slice(0,256)});
      throw error;
    }
  },
  compositionReadContentKind: async (id: string) => {
    const { root } = (await repository.read(id)).checkpoint;
    return root.id === id && (root.kind === 'document' || root.kind === 'markdown') ? root.kind : null;
  },
  compositionResourceReadCounts: () => ({ ...resourceReadCounts }),
    // Read-port timing only: real repository bytes, validation and browser image decode still run after release.
    compositionHoldResourceReads: (id: string) => {
      if (heldResourceReads.has(id)) throw new Error('resource-read-already-held');
      let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
      heldResourceReads.set(id, { wait, release });
    },
    compositionReleaseResourceReads: (id: string) => { const held = heldResourceReads.get(id); heldResourceReads.delete(id); held?.release(); },
  compositionHighlightEvidence: () => {
    const root = document.querySelector<HTMLElement>('[data-reader-root]');
    const pane = root?.querySelector<HTMLElement>('[data-reader-surface][data-active-surface="true"] [data-pdf-scroller]') ?? null;
    return readHighlightDiagnostic(root, pane);
  },
  compositionReferenceInputEvidence: () => {
    const root = document.querySelector<HTMLElement>('[data-reader-root]');
    const pane = root?.querySelector<HTMLElement>('[data-reader-reference] [data-pdf-scroller], [data-reader-reference] .document-paper-pane') ?? null;
    return readReferenceInputSnapshot(root, pane);
  },
  compositionScopeLeave: () => sessions.prepareLeave(),
  // Read only an already-observed session. No session creation or repository I/O.
  compositionMarkdownSessionWitness: (id: string) => {
    const registry = sessions.getSnapshot(), session = observedMarkdown.get(id);
    if (!session || bootstrap.getActiveRuntime() !== runtime || !registry.ready || !registry.active) return null;
    let owner = markdownSessionWitnessIds.get(session);
    if (!owner) { owner = String(++markdownWitnessSequence); markdownSessionWitnessIds.set(session, owner); }
    const state = session.getSnapshot();
    let editor = state.editorOwner ? markdownEditorWitnessIds.get(state.editorOwner) : undefined;
    if (state.editorOwner && !editor) { editor = String(++markdownWitnessSequence); markdownEditorWitnessIds.set(state.editorOwner, editor); }
    return { owner, editor: editor ?? null, canLeave: session.canLeave(), ready: state.ready, saving: state.saving,
      dirty: state.dirty, content: state.content, documentId: runtime.navigation.getSnapshot().documentId };
  },
  compositionNavigationEvidence: () => {
    const documentId = document.querySelector('[data-content-document]')?.getAttribute('data-content-document') ?? null;
    return { navigation: runtime.navigation.getSnapshot(), documentId, readerState: documentId ? documentLibrary.readerState.read(documentId) : null, document: documentId ? observedDocuments.get(documentId)?.getSnapshot() : undefined,
      markdown: documentId ? observedMarkdown.get(documentId)?.getSnapshot() : undefined,
      observedDocuments: [...observedDocuments.keys()], observedMarkdown: [...observedMarkdown.keys()] };
  },
  // The controlled landing poll needs only this authorized witness read and live transfer state.
  compositionWitnessEvidence: async (id: string) => ({ state: await repository.read(id), replication: replication.getSnapshot() }),
  compositionObservedEvidence: async (id: string) => ({ state: await repository.read(id), pending: await repository.pendingRecords(),
    document: observedDocuments.get(id)?.getSnapshot(), markdown: observedMarkdown.get(id)?.getSnapshot(),
    replication: replication.getSnapshot(), leave: await sessions.prepareLeave() }),
  compositionReadResource: async (id: string) => {
    const resource = await repository.readResource(id);
    return resource ? { metadata: resource.metadata, bytes: Array.from(resource.bytes) } : undefined;
  },
});

}
