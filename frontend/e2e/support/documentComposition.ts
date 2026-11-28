import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { waitForNativeProcessPort } from './process/nativeProcessStartup.ts';
import fs from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, webkit, type Page, type Browser, type BrowserContext } from 'playwright-core';
import { createCompositionDrive, installBrowserDriveBoundary, type DriveFixtureRequest, type IncomingEditListMode } from './provider/fakeDrive.ts';
import { scopeKey } from '../../src/runtime/edits/repository.ts';
import { assertEditRecord } from '../../src/runtime/edits/editRecord.ts';
import { canonicalJson } from '../../src/runtime/edits/editModel.ts';
import type { ContentRepository, EditScope } from '../../src/runtime/edits/ports.ts';
import type { ContentPublication, LibrarySnapshot, ResourceMetadata, EditRecord } from '../../src/runtime/edits/contracts.ts';
import type { BatchReceipt, RepositoryState } from '../../src/runtime/edits/ports.ts';
import type { DocumentEditState } from '../../src/features/reader/edit/DocumentEditSession.ts';
import type { MarkdownEditState } from '../../src/features/notes/markdown/MarkdownEditSession.ts';
import type { ScopeLeaveResult } from '../../src/features/reader/DocumentEditSessions.ts';
import { publicationResourceIds, snapshotResourceIds, batchResourceIds } from '../../src/runtime/edits/contentPublication.ts';
import { isCaughtCorpusNavigationError, assertCompositionBrowserObservations } from './compositionBrowserErrors.ts';
import { verifyCompositionResourceClosure, collectCompositionResources } from './compositionResources.ts';

const frontend = path.resolve(import.meta.dirname, '../..'), root = path.resolve(frontend, '..');
// The seed callback can replace a PDF document with Markdown; read through a fresh type boundary.
const publicationKind = (publication: ContentPublication) => publication.content?.kind;
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/shared-edits.json'), 'utf8')) as {
  libraryId: string; library: LibrarySnapshot; publications: { name: string; value: ContentPublication }[];
  resource: { file: string; metadata: ResourceMetadata };
};
/** Existing read-only fixture getters and visible form state; never capability values. */
const sanitizeNativeCloseReason = (reason: string, bearer: string) => reason.split(bearer).join('[bearer]')
  .split('synthetic native ordinary offline passphrase').join('[secret]').replace(/\bBearer\s+[^\s,;"']+/gi,'Bearer [redacted]')
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'[id]')
  .replace(/[A-Za-z0-9_-]{40,}/g,'[opaque]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,320);
const readNativeCloseReadiness = (page: Page) => page.evaluate(async () => {
  const api = window as unknown as {
    compositionLibraryMemory(): { session: { ready: boolean; busy: boolean; pendingId: string | null; error: string; createdFolderId: string | null } } | null;
    compositionBootstrapStatus(): { state: { phase: string; locked: boolean }; provider?: { busy: boolean; pendingGuard: boolean } };
    compositionPendingIntentCount(): Promise<number>;
  };
  if (typeof api.compositionPendingIntentCount !== 'function') throw new Error('native-fixture-pending-intent-count-unavailable');
  const memory = api.compositionLibraryMemory(), state = memory?.session, bootstrap = api.compositionBootstrapStatus();
  const form = document.querySelector('form[aria-label="フォルダーの操作"]');
  const pendingCount = await api.compositionPendingIntentCount();
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) throw new Error('native-fixture-invalid-pending-intent-count');
  const journalPending = pendingCount > 0;
  return { libraryObserved: !!state, libraryReady: !!state?.ready, libraryBusy: !!state?.busy,
    libraryPending: !!state?.pendingId, libraryError: !!state?.error, createdFolder: !!state?.createdFolderId,
    folderFormOpen: !!form, journalPending, bootstrapLocked: !!bootstrap.state.locked,
    providerBusy: !!bootstrap.provider?.busy, providerPending: !!bootstrap.provider?.pendingGuard };
});
/** Unlike generic snapshot polling, a broken/unsupported probe fails immediately. */
export async function waitForNativeCloseReadiness(page: Page, options: { requireCreatedFolder?: boolean } = {}) {
  const deadline = Date.now() + 25_000;
  let last: Awaited<ReturnType<typeof readNativeCloseReadiness>> | undefined;
  while (Date.now() < deadline) {
    last = await readNativeCloseReadiness(page);
    if (last.libraryObserved && last.libraryReady && !last.libraryBusy && !last.libraryPending && !last.libraryError
      && (options.requireCreatedFolder === false || last.createdFolder) && !last.folderFormOpen && !last.journalPending && !last.bootstrapLocked && !last.providerBusy && !last.providerPending) return last;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('native-close-readiness-timeout: '+JSON.stringify(last));
}
export type Evidence = { state: RepositoryState; session: DocumentEditState; pending: EditRecord[] };
export type Diagnostics = { session: DocumentEditState; replication: { running: boolean } };
export type MarkdownEvidence = { state: RepositoryState; session: MarkdownEditState; pending: EditRecord[]; leave: ScopeLeaveResult };
export type MarkdownDiagnostics = { session: MarkdownEditState; replication: { running: boolean } };
export const markdownEvidence = (page: Page) => page.evaluate(() => (window as unknown as { compositionMarkdownEvidence(): Promise<MarkdownEvidence> }).compositionMarkdownEvidence());
const delivery = new WeakMap<Page, () => Promise<void>>();
const legacyDraftPages = new WeakMap<Page, { page: Page; error: string }>();
/** Read the retained, genuinely blocked legacy profile paired with this canonical page. */
export async function readLegacyDraftEvidence(page: Page): Promise<(string | null)[]> {
  const legacy = legacyDraftPages.get(page);
  assert.ok(legacy && !legacy.page.isClosed(), 'retained legacy profile required');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error('legacy draft evidence read timed out');
  const value = await Promise.race([legacy.page.evaluate(() => {
    const current = window as unknown as { compositionBootstrapStatus(): { state: { phase: string; error: string } }; fixtureGesture?: boolean };
    return { state: current.compositionBootstrapStatus().state, gesture: current.fixtureGesture,
      values: [localStorage.getItem('paperdesk-draft-sentinel'), localStorage.getItem('papeer-draft-sentinel')] };
  }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError), 25_000); })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  assert.equal(value.state.phase, 'recovery-required');assert.equal(value.state.error, legacy.error);
  assert.equal(value.gesture, undefined);
  assert.deepEqual(value.values, ['untouched raw draft', null]);
  return value.values;
}
/** Observe only the actual idle predicate; durability is checked by delivery and after-idle catalog. */
export async function waitForCompositionReplicationIdle(page: Page): Promise<void> {
  const deadline = Date.now() + 25_000, timeoutError = new Error('snapshot read timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => {
        const remaining = Math.min(25_000, deadline - Date.now());
        if (remaining <= 0) throw timeoutError;
        return page.evaluate(remaining => (window as unknown as {
          compositionWaitForReplicationIdle(remaining: number): Promise<void>;
        }).compositionWaitForReplicationIdle(remaining), remaining);
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError), Math.min(25_000, Math.max(0, deadline - Date.now()))); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function markdownSync(page: Page) {
  await sync(page);
  await page.waitForFunction(() => {
    const {session}=(window as unknown as {compositionMarkdownDiagnostics():MarkdownDiagnostics}).compositionMarkdownDiagnostics();
    return session.ready && !session.dirty && !session.saving && session.durable && !session.editingBlocked;
  });
  assert.equal((await markdownEvidence(page)).pending.length,0);
}
export const evidence = (page: Page) => page.evaluate(() => (window as unknown as { compositionEvidence(): Promise<Evidence> }).compositionEvidence());
export async function settled(page: Page, count: number) {
  await page.waitForFunction(expected => {
    const read = (window as unknown as { compositionDiagnostics?: () => Diagnostics }).compositionDiagnostics;
    if (!read) return false;
    const value = read();
    return value.session.phase === 'idle' && value.session.document?.pages[0].annotations.length === expected;
  }, count);
  await page.waitForFunction(expected => document.querySelectorAll('[data-ink-id]').length === expected, count);
}
export async function gesture(page: Page, points: [number, number][]) {
  const layer = page.getByLabel('PDF書き込みレイヤー', { exact: true });
  const deadline = performance.now() + 25_000;
  let measured: { x: number; y: number; width: number; height: number } | null = null;
  while (!measured) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('live ink layer readiness deadline exceeded');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      measured = await Promise.race([layer.evaluate(async (element, first) => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (!element.isConnected) return null;
        const before = element.getBoundingClientRect();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (!element.isConnected) return null;
        const current = element.getBoundingClientRect(), style = getComputedStyle(element);
        if (!(before.width > 0 && before.height > 0 && current.width > 0 && current.height > 0) || style.display === 'none' || style.visibility !== 'visible'
          || style.opacity === '0' || before.x !== current.x || before.y !== current.y || before.width !== current.width || before.height !== current.height) return null;
        const target = document.elementFromPoint(current.x + first[0] * current.width, current.y + first[1] * current.height);
        return target && element.contains(target) ? { x: current.x, y: current.y, width: current.width, height: current.height } : null;
      }, points[0], { timeout: remaining }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('live ink layer readiness deadline exceeded')), remaining); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const box = measured;
  const logGeometry = async (phase: 'gesture-start' | 'gesture-end') => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([layer.evaluate((element, requested) => ({ at: performance.now(), focused: document.hasFocus(), visibility: document.visibilityState,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, bounds: element.getBoundingClientRect().toJSON(),
        activeElement: document.activeElement && { tag: document.activeElement.tagName, label: document.activeElement.getAttribute('aria-label') },
        points: requested.map(point => { const target = document.elementFromPoint(point.clientX, point.clientY);
          return { ...point, hitTarget: target && { tag: target.tagName, label: target.getAttribute('aria-label') }, insideLayer: !!target && element.contains(target) }; }) }),
      points.map(([x,y]) => ({ normalizedX:x, normalizedY:y, clientX:box.x+x*box.width, clientY:box.y+y*box.height }))),
      new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error('gesture geometry diagnostic timeout')),2000); })]).finally(() => { if(timer!==undefined)clearTimeout(timer); });
      console.error(`composition-gesture ${phase}: ${JSON.stringify(value)}`);
    } catch (cause) { console.error(`composition-gesture ${phase}: diagnostic unavailable: ${String(cause)}`); }
  };
  await logGeometry('gesture-start');
  await page.mouse.move(box.x + points[0][0] * box.width, box.y + points[0][1] * box.height);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x * box.width, box.y + y * box.height, { steps: 12 });
  await page.mouse.up();
  await logGeometry('gesture-end');
}
export async function sync(page: Page) {
  const run=delivery.get(page);if(!run)throw new Error('genuine-composition-delivery-not-registered');await run();
}
/** Catch-only, read-only evidence; bounded even when a page no longer responds. */
export async function captureReferenceFailure(t: TestContext, pages: Page[], phase: string) {
  for (const [index, page] of pages.entries()) {
    const host = new URL(page.url()).searchParams.get('host') ?? (index === 0 ? 'native' : 'web');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const details = await Promise.race([page.evaluate(() => {
        const value = window as unknown as { compositionNavigationEvidence?: () => { documentId: string | null; document?: { ready?: boolean; phase?: string; error?: string; inputActive?: boolean } }; compositionReferenceInputEvidence?: () => unknown; compositionStartupEvidence?: () => unknown; compositionFailureRenderEvidence?: () => unknown; compositionBootstrapStatus?: () => unknown };
        const nav = value.compositionNavigationEvidence?.(), state = nav?.document;
        return { url: location.href, documentId: nav?.documentId, document: state && { ready: state.ready, phase: state.phase, error: state.error, inputActive: state.inputActive },
          port: value.compositionReferenceInputEvidence?.() ?? null, render: value.compositionFailureRenderEvidence?.(), startup: value.compositionStartupEvidence?.(), bootstrap: value.compositionBootstrapStatus?.(),
          roots: [...document.querySelectorAll('[data-reader-root], [data-reader-reference], [data-canonical-page], [data-paper-page], [data-pdf-scroller], [role="status"], [role="alert"]')].slice(0, 30).map(element => ({ tag: element.tagName, page: element.getAttribute('data-canonical-page') ?? element.getAttribute('data-paper-page'), revision: element.getAttribute('data-background-revision'), rendered: element.getAttribute('data-rendered'), text: (element.getAttribute('role') ? element.textContent : '')?.slice(0, 300) })) };
      }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic timeout')), 2_000); })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      t.diagnostic(`reference-failure ${phase} ${host}: ${JSON.stringify(details)}`);
    } catch (cause) { t.diagnostic(`reference-failure ${phase} ${host} diagnostic error: ${String(cause)}`); }
    try {
      const intent = await Promise.race([page.evaluate(async () => {
        const id = document.querySelector('[data-content-document]')?.getAttribute('data-content-document');
        const read = (window as unknown as { compositionReadIntent?: (id: string) => Promise<unknown> }).compositionReadIntent;
        return id && read ? { documentId: id, intent: await read(id) } : null;
      }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('intent diagnostic timeout')), 2_000); })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      t.diagnostic(`reference-failure ${phase} ${host} current-intent: ${JSON.stringify(intent)}`);
    } catch (cause) { t.diagnostic(`reference-failure ${phase} ${host} intent diagnostic error: ${String(cause)}`); }
    try {
      const output = path.join(root, 'output', `reference-failure-${process.pid}-${Date.now()}-${host}.png`);
      await page.screenshot({ path: output, timeout: 2_000 }); t.diagnostic(`reference-failure screenshot: ${output}`);
    } catch (cause) { t.diagnostic(`reference-failure ${phase} ${host} screenshot error: ${String(cause)}`); }
  }
}

/** Host-owned fixture transport; no grant/admission is constructed by the caller. */
export async function openComposition(t: TestContext, engine: 'chromium' | 'webkit', seed?: (publication: ContentPublication) => void,
  options: { nativeColdRestart?: boolean; emptyScope?: boolean; allowImageResources?: boolean; allowAttachmentResources?: boolean; hasTouch?: boolean; pdfFixture?: 'text'; additionalPublications?: (publication: ContentPublication) => {
    publications: ContentPublication[]; initialDocumentId: string;
  } } = {}) {
  const directory=fs.mkdtempSync(path.join(tmpdir(),'papeer-intent-http-'));
  const legacy=path.join(directory,'legacy-library');fs.mkdirSync(legacy);
  const database=path.join(legacy,'library.sqlite3'),sentinel='invalid SQLite: canonical UI must never open this legacy database';fs.writeFileSync(database,sentinel);
  const selected=path.join(directory,'canonical');fs.mkdirSync(selected);
  let token=crypto.randomUUID(),nativeDriveOffline=false;const drive=createCompositionDrive();
  const publications:ContentPublication[]=[];let publication!:ContentPublication,documentId='',contentKind:'document'|'markdown'='document';
  const config:{documentId:string;contentKind:'document'|'markdown';emptyScope:boolean;loopbackToken:string;seededContents:{id:string;kind:'document'|'markdown'}[]}={
    documentId:fixture.publications.find(value=>value.name==='pdf')!.value.content!.id,contentKind:'document',emptyScope:!!options.emptyScope,loopbackToken:token,seededContents:[]};
  let child:ChildProcess|undefined,server:ViteDevServer|undefined,browser:Browser|undefined,port=0;
  let nativeBrowser:Browser|undefined,nativeState:Awaited<ReturnType<BrowserContext['storageState']>>|undefined;
  let nativeGeneration=0,lastIssuedLease:string|undefined;
  const nativeRestartWitnesses:{generation:number;bearerRotated:boolean;oldBearerRefused:boolean;oldLeaseRefused:boolean}[]=[];
  const pages:Page[]=[],legacyPages:Page[]=[],errors:string[]=[],forbidden:string[]=[],navigationDiagnostics:string[]=[],unhandled:string[]=[];
  const apiCalls:string[]=[],resourceCalls:string[]=[],committed:string[]=[],committedPayloads:string[]=[],published:string[]=[],publishedPayloads:string[]=[];
  const nativeRpcEvidence:Record<string,unknown>[]=[],leaseLabels=new Map<string,string>(),operationLabels=new Map<string,string>();
  let nativeRpcSequence=0;
  const rpcLabel=(values:Map<string,string>,prefix:string,value:unknown)=>{
    if(typeof value!=='string'||!value)return undefined;
    let label=values.get(value);if(!label){if(values.size>=32)return prefix+'-overflow';label=prefix+(values.size+1);values.set(value,label);}return label;
  };
  const recordNativeRpc=(entry:Record<string,unknown>)=>{nativeRpcEvidence.push({atMs:Math.round(performance.now()-flowStarted),...entry});if(nativeRpcEvidence.length>64)nativeRpcEvidence.shift();};
  const selectedNativeRpc=new Set(['/api/edits/provider-owner/health','/api/edits/provider-owner/resume-retained','/api/edits/provider-owner/cancel-resume','/api/edits/provider-owner/acknowledge-resume','/api/edits/provider-owner/discard-resumed','/api/edits/provider-owner/finish-connect','/api/edits/provider-owner/open-installed','/api/edits/provider-owner/open-selected','/api/edits/provider-owner/disconnect','/api/edits/provider-owner/cancel-connect','/api/edits/bootstrap/local-context/read','/api/edits/bootstrap/local-context/provision','/api/edits/bootstrap/inspect','/api/edits/bootstrap/revalidate','/api/edits/bootstrap/release']);
  const knownRpcErrors=new Set(['canonical-authority-denied','operation-denied','missing-target','provider-operation-invalid','lease-expired','provider-admission-invalid','provider-unavailable','drive-provider-http-429','drive-provider-http-500','drive-provider-http-502','drive-provider-http-503','drive-provider-http-504','drive-provider-network','provider-sync-suspended']);

  let loseCommitReply=false,loseCommitReplies=false,losePublishReplies=false,documentModulesAllowed=false,stage='opening',flowStep='opening';
  const flowStarted=performance.now();
  const markFlow=(page:Page,step:string)=>{flowStep=step;console.error('composition-flow '+(pages.indexOf(page)===0?'native':'web')+' '+step+' elapsed-ms='+Math.round(performance.now()-flowStarted));};
  // Startup timing observation only (PAPEER_COMPOSITION_STARTUP_TIMING=1). It adds marks and read-only page snapshots; it never changes a wait,
  // deadline, retry, assertion or product call. Observing can itself change timing (the 10-27 r3 precedent), so runs record the flag.
  const startupTiming=process.env.PAPEER_COMPOSITION_STARTUP_TIMING==='1',flowStartedEpoch=Date.now();
  const startupMarks:Record<string,unknown>[]=[];
  const pageRequests=new Map<Page,{started:number;finished:number;failed:number;lastFinishedAtMs:number}>();
  const hostOf=(page:Page)=>(legacyPages.includes(page)?'legacy-':'')+(new URL(page.url()).searchParams.get('host')??'unknown');
  const markStartup=(source:string,step:string,detail?:Record<string,unknown>)=>{
    if(!startupTiming)return;
    const epochMs=Date.now(),atMs=epochMs-flowStartedEpoch;
    startupMarks.push({source,step,atMs,epochMs,freeMemMb:Math.round(freemem()/1048576),...detail});
    console.error('composition-startup '+source+' '+step+' at-ms='+atMs);
  };
  const emitStartupTable=(t:TestContext,outcome:string)=>{if(startupTiming)t.diagnostic('composition-startup-timing '+JSON.stringify({engine,outcome,flowStartedEpochMs:flowStartedEpoch,marks:startupMarks}));};
  // Bounded read-only page snapshot: visibility/focus/lazy/root lanes from the existing render evidence, plus how late a 0 ms timer and an animation frame run.
  const startupSnapshot=async(page:Page,host:string,label:string,full:boolean)=>{
    if(!startupTiming)return;
    const nodeEpochMs=Date.now(),counters=pageRequests.get(page);let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const value=await Promise.race([page.evaluate(async()=>{
        const w=window as unknown as {compositionFailureRenderEvidence?:()=>{react?:{fibers?:unknown};[key:string]:unknown};compositionBootstrapStatus?:()=>{state:{phase:string}};
          compositionNavigationEvidence?:()=>{documentId:string|null;document?:{ready?:boolean;phase?:string}}};
        const timeoutDelayMs=await new Promise<number>(resolve=>{const started=performance.now();setTimeout(()=>resolve(performance.now()-started),0);});
        const frameDelayMs=await Promise.race([new Promise<number>(resolve=>{const started=performance.now();requestAnimationFrame(()=>resolve(performance.now()-started));}),new Promise<null>(resolve=>setTimeout(()=>resolve(null),1000))]);
        const nav=w.compositionNavigationEvidence?.(),render=w.compositionFailureRenderEvidence?.();
        return {pageNowMs:performance.now(),pageEpochMs:Date.now(),timeOrigin:performance.timeOrigin,timeoutDelayMs,frameDelayMs,visibility:document.visibilityState,focused:document.hasFocus(),
          bootstrapPhase:w.compositionBootstrapStatus?.().state.phase,documentId:nav?.documentId,document:nav?.document&&{ready:nav.document.ready,phase:nav.document.phase},
          headings:[...document.querySelectorAll('h1,h2,h3')].slice(0,4).map(element=>(element.textContent??'').slice(0,60)),
          contentDocument:!!document.querySelector('[data-content-document]'),render:render};
      }),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('startup snapshot timeout')),3000);})]);
      const react=(value.render as {react?:{fibers?:unknown}}|undefined)?.react;
      if(!full&&react)delete react.fibers;
      markStartup(host,'snapshot.'+label,{snapshot:{pageNowMs:Math.round(value.pageNowMs),timeoutDelayMs:Math.round(value.timeoutDelayMs),frameDelayMs:value.frameDelayMs===null?null:Math.round(value.frameDelayMs),visibility:value.visibility,focused:value.focused,
        bootstrapPhase:value.bootstrapPhase,documentId:value.documentId,document:value.document,contentDocument:value.contentDocument,headings:value.headings,requests:counters&&{...counters}}});
      t.diagnostic(`composition-startup-snapshot ${host} ${label}: ${JSON.stringify({nodeEpochMs,requests:counters,...value})}`);
    }catch(cause){markStartup(host,'snapshot.'+label+'.unavailable',{error:String(cause).slice(0,200)});}
    finally{if(timer!==undefined)clearTimeout(timer);}
  };
  let heldReply:{received(id:string):void;wait:Promise<void>;release():void}|undefined;
  const replyReleases=new Set<()=>void>();
  const remote=()=>[...drive.files.values()].flatMap(file=>{try{return [JSON.parse(file.body) as {kind:string;record?:EditRecord;batchId?:string;peerId?:string;metadata?:ResourceMetadata;blobId?:string}];}catch{return [];}});
  const records=()=>remote().filter(value=>value.kind==='edit-record').map(value=>value.record!);
  const imports=()=>remote().filter(value=>value.kind==='import-receipt');
  const nativeCall=async(endpoint:string,body:unknown,headers:Record<string,string>,method='POST')=>fetch(`http://127.0.0.1:${port}${endpoint}`,{method,headers,body:method==='POST'?JSON.stringify(body):undefined});
  const shutdown=async()=>{
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    const closed=once(child,'close');
    try{await nativeCall('/shutdown',{}, {'Authorization':'Bearer '+token,'Content-Type':'application/json'});}catch{/* the owned sidecar may already be closed */}
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('owned-composition-sidecar-did-not-drain')),35000);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  };
  t.after(async()=>{
    drive.setIncomingEditListMode('native','normal');drive.setIncomingEditListMode('web','normal');
    t.diagnostic(`composition native-rpc final evidence: ${JSON.stringify({flowStep,entries:[...nativeRpcEvidence]})}`);
    for(const release of replyReleases)release();
    for(const page of [...pages,...legacyPages])if(!page.isClosed())await page.evaluate(()=>(window as unknown as {compositionClose?:()=>Promise<ScopeLeaveResult>}).compositionClose?.()).catch(()=>undefined);
    await nativeBrowser?.close();await browser?.close();await server?.close();await shutdown();
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('papeer-intent-http-'));
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  try {
  markStartup('node','vite.create.before');
  server=await createServer({root:frontend,configFile:path.join(frontend,'vite.config.ts'),logLevel:'error',cacheDir:path.join(directory,'vite-cache'),optimizeDeps:{entries:['e2e/fixtures/documentComposition.html']},
    server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[root,fs.realpathSync(path.join(frontend,'node_modules/@fontsource-variable/geist'))]}},plugins:[{name:'genuine-composition-transport',configureServer(vite){
      vite.middlewares.use(async(request,response,next)=>{
        const endpoint=request.url?.split('?')[0]??'';
        if(endpoint!=='/drive'&&!endpoint.startsWith('/composition/')&&!endpoint.startsWith('/api/')){next();return;}
        const rpc=++nativeRpcSequence,rpcStarted=performance.now(),selectedRpc=selectedNativeRpc.has(endpoint);
        const labels={lease:rpcLabel(leaseLabels,'L',request.headers['x-papeer-host-lease']),operation:rpcLabel(operationLabels,'O',request.headers['x-papeer-provider-operation'])};
        if(selectedRpc)recordNativeRpc({rpc,endpoint,phase:'start',...labels});
        if(endpoint.startsWith('/api/edits/'))response.once('close',()=>{if(!response.writableEnded)recordNativeRpc({rpc,endpoint,phase:'client-response-closed-before-end',elapsedMs:Math.round(performance.now()-rpcStarted),...labels});});
        try{
          const chunks:Buffer[]=[];let size=0;for await(const chunk of request){const value=Buffer.from(chunk);size+=value.length;if(size>64*1024*1024)throw new Error('bounded-fixture-body');chunks.push(value);}
          const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
          if(endpoint==='/composition/config'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(config));return;}
          if(endpoint==='/drive'){
            assert.equal(request.headers.authorization,'Bearer '+token);
            const result=nativeDriveOffline?{status:503,headers:{},bodyBase64:Buffer.from('{}').toString('base64')}:await drive.request(body as DriveFixtureRequest,'native');response.setHeader('Content-Type','application/json');response.end(JSON.stringify(result));return;
          }
          if(!endpoint.startsWith('/api/edits/'))throw new Error('obsolete-or-unscoped-composition-endpoint');
          apiCalls.push(endpoint);if(/\/(store-resource|read-resource|resource-metadata)$/.test(endpoint))resourceCalls.push(endpoint);
          const headers:Record<string,string>={'Content-Type':'application/json'};
          for(const name of ['authorization','x-papeer-host-lease','x-papeer-admission','x-papeer-provider-operation']){
            const value=request.headers[name];if(typeof value==='string')headers[name]=value;
          }
          const reply=await nativeCall(endpoint,body,headers),value=await reply.text();
          if(selectedRpc||!reply.ok){
            let row:Record<string,unknown>={};try{const parsed:unknown=JSON.parse(value);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))row=parsed as Record<string,unknown>;}catch{/* diagnostic parsing never changes the original response */}
            const code=typeof row.detail==='string'&&knownRpcErrors.has(row.detail)?row.detail:reply.ok?undefined:'other-error';
            recordNativeRpc({rpc,endpoint,phase:'response',status:reply.status,elapsedMs:Math.round(performance.now()-rpcStarted),clockEpochMs:Date.now(),active:typeof row.active==='boolean'?row.active:undefined,code,
              lease:rpcLabel(leaseLabels,'L',row.leaseId)??labels.lease,operation:rpcLabel(operationLabels,'O',row.operationId)??labels.operation});
          }

          if(options.nativeColdRestart&&reply.ok){try{const row=JSON.parse(value) as {leaseId?:unknown};if(typeof row.leaseId==='string')lastIssuedLease=row.leaseId;}catch{/* readonly lifecycle evidence only */}}
          if(reply.ok&&(endpoint.endsWith('/commit')||endpoint.endsWith('/publish'))){
            const result=JSON.parse(value) as {status?:string};
            if(result.status==='durable'){
              if(endpoint.endsWith('/publish')){published.push(body.publication.libraryBatch.id);publishedPayloads.push(JSON.stringify(body));if(losePublishReplies){response.statusCode=503;response.end('fixture reply lost after durable publication');return;}}
              else{committed.push(body.batch.id);committedPayloads.push(JSON.stringify(body));if(heldReply){const held=heldReply;heldReply=undefined;held.received(body.batch.id);await held.wait;replyReleases.delete(held.release);}if(loseCommitReply||loseCommitReplies){loseCommitReply=false;response.statusCode=503;response.end('fixture reply lost after durable commit');return;}}
            }
          }
          response.statusCode=reply.status;response.setHeader('Content-Type','application/json');response.end(value);
        }catch(error){if(endpoint.startsWith('/api/edits/'))recordNativeRpc({rpc,endpoint,phase:'proxy-error',elapsedMs:Math.round(performance.now()-rpcStarted),errorName:error instanceof Error&&['AbortError','TypeError','TimeoutError','Error'].includes(error.name)?error.name:'other-error',...labels});response.statusCode=500;response.end(String(error));}
      });
    }}]});
  markStartup('node','vite.create.after');await server.listen();markStartup('node','vite.listen.after');const address=server.httpServer?.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
  const python=path.join(root,'.venv/Scripts/python.exe');assert.ok(fs.existsSync(python));
  const childEnv={...process.env};for(const key of Object.keys(childEnv))if(/^(PAPEER_|PAPERDESK_|GOOGLE_|WEBVIEW2_)/i.test(key))delete childEnv[key];
  for(const key of ['LOCALAPPDATA','APPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME']){const target=path.join(directory,'env',key);fs.mkdirSync(target,{recursive:true});childEnv[key]=target;}
  for(const key of ['TEMP','TMP','TMPDIR'])childEnv[key]=tmpdir();
  if(process.env.PAPEER_COMPOSITION_STARTUP_DIAGNOSTICS==='1')childEnv['PAPEER_COMPOSITION_STARTUP_DIAGNOSTICS']='1';
  if(startupTiming)childEnv['PAPEER_COMPOSITION_STARTUP_TIMING']='1';
  const startNativeProcess=async(mode:'initial'|'resume')=>{
  assert.ok(mode==='initial'||options.nativeColdRestart,'owned Native restart must be enabled');
  const canonical=path.join(directory,'.canonical-shared-app','content.sqlite3');
  assert.equal(path.dirname(path.dirname(canonical)),directory);
  if(mode==='initial')assert.equal(fs.existsSync(canonical),false,'initial canonical fixture must be fresh');
  else assert.ok(fs.statSync(canonical).isFile(),'resume canonical fixture must remain in place');
  markStartup('sidecar',mode+'.spawn.before');
  const launched=spawn(python,['-B',path.join(frontend,'e2e/fixtures/editApi.py'),path.join(selected,'library.sqlite3'),token,'provider-composition',origin+'/drive',path.join(directory,'device-state-fixture')],{cwd:root,env:childEnv,stdio:['ignore','pipe','pipe'],windowsHide:true});
  child=launched;markStartup('sidecar',mode+'.spawn.after');
  let nativeTimingLines='';launched.stderr!.on('data',value=>{
    const text=String(value);nativeTimingLines+=text;
    let newline:number;while((newline=nativeTimingLines.indexOf('\n'))>=0){const line=nativeTimingLines.slice(0,newline);nativeTimingLines=nativeTimingLines.slice(newline+1);
      if(line.startsWith('composition-native-timing:'))t.diagnostic(line);
      if(startupTiming&&line.startsWith('composition-sidecar-timing:')){try{const value=JSON.parse(line.slice('composition-sidecar-timing:'.length)) as {step:string;epochMs:number};markStartup('sidecar-py',String(value.step).slice(0,64),{pyAtMs:Math.round(value.epochMs-flowStartedEpoch)});}catch{/* timing line only */}}
    }
    if(nativeTimingLines.length>16384)nativeTimingLines=nativeTimingLines.slice(-16384);
  });
  port=await waitForNativeProcessPort(launched,{mode,generation:nativeGeneration+1,redactions:[token,root,frontend,directory,selected,python]});
  markStartup('sidecar',mode+'.port-line');nativeGeneration++;
  };
  const launchBrowser=()=>engine==='chromium'?chromium.launch({channel:'msedge',headless:true}):webkit.launch({headless:true});
  await startNativeProcess('initial');
  markStartup('browser','launch.before');browser=await launchBrowser();markStartup('browser','launch.after');if(options.nativeColdRestart)nativeBrowser=await launchBrowser();
  const departingControllers=new Map<Page,string>();
  const connect=async(page:Page,creating=false)=>{
    markStartup(hostOf(page),'connect.before');
    await page.getByRole('button',{name:'Google Drive\u3092\u4f7f\u3046',exact:true}).click();markStartup(hostOf(page),'connect.drive-button-clicked');
    const authButton=page.getByRole('button',{name:'Google\u306b\u63a5\u7d9a',exact:true});
    const connectedSignal=creating
      ? page.getByLabel('\u65b0\u3057\u3044\u30af\u30e9\u30a6\u30c9\u30e9\u30a4\u30d6\u30e9\u30ea\u306e\u540d\u524d')
      : page.getByRole('button',{name:'Drive\u306e\u4e00\u89a7\u3092\u66f4\u65b0',exact:true});
    await authButton.or(connectedSignal).first().waitFor({timeout:25_000});
    if(await authButton.isVisible())await authButton.click();
    if(creating){await page.getByLabel('\u65b0\u3057\u3044\u30af\u30e9\u30a6\u30c9\u30e9\u30a4\u30d6\u30e9\u30ea\u306e\u540d\u524d').fill('Composition '+engine);await page.getByRole('button',{name:'\u30af\u30e9\u30a6\u30c9\u30e9\u30a4\u30d6\u30e9\u30ea\u3092\u4f5c\u6210',exact:true}).click();}
    else{await page.getByRole('button',{name:'Drive\u306e\u4e00\u89a7\u3092\u66f4\u65b0',exact:true}).click();await page.getByRole('button',{name:'Composition '+engine,exact:true}).click();}
    markStartup(hostOf(page),'connect.bootstrap-wait-start');
    await page.waitForFunction(()=>(window as unknown as {compositionBootstrapStatus():{state:{phase:string}}}).compositionBootstrapStatus().state.phase==='ready');
    markStartup(hostOf(page),'connect.bootstrap-ready');
  };
  const configure=async(page:Page)=>page.evaluate(value=>(window as unknown as {compositionConfigure(value:unknown):void}).compositionConfigure(value),{documentId:config.documentId,contentKind:config.contentKind,seededContents:config.seededContents});
  const deliver=async(page:Page)=>{
    const expected=records().map(record=>({batchId:record.batch.id,targetId:record.batch.targetId})),expectedIds=expected.map(value=>value.batchId),deadline=Date.now()+30000;
    let lastSample:unknown=null;
    let awaitingOperation:'compositionDelivery'|'delivery-evidence'|'replication-idle'|'delivery-predicates'='compositionDelivery';
    let next:'full'|'idle'='full';
    const withinDeadline=async<T,>(operation:()=>Promise<T>):Promise<T>=>{
      const remaining=deadline-Date.now();if(remaining<=0)throw new Error('exact durable provider delivery deadline exceeded');
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('exact durable provider delivery deadline exceeded')),remaining);})]);}
      finally{if(timer!==undefined)clearTimeout(timer);}
    };
    try{
    for(;;){
      const mode:'full'|'observe'=next==='idle'?'observe':'full';
      if(next==='idle'){
        awaitingOperation='replication-idle';markFlow(page,'replication-idle.before');
        await withinDeadline(()=>page.evaluate(remaining=>(window as unknown as {compositionWaitForReplicationIdle(remaining:number):Promise<void>}).compositionWaitForReplicationIdle(remaining),deadline-Date.now()));
        markFlow(page,'replication-idle.after');
      }
      awaitingOperation=mode==='full'?'compositionDelivery':'delivery-evidence';
      markFlow(page,mode==='full'?'flush-start':'delivery-observe-start');
      const value:{pending:EditRecord[];peerId:string;receipts:(BatchReceipt|null|undefined)[];replication:{running:boolean;error:string}}=await withinDeadline(()=>page.evaluate(({expected,mode})=>(window as unknown as {compositionDelivery(expected:{batchId:string;targetId:string}[],mode:'full'|'observe'):Promise<{pending:EditRecord[];peerId:string;receipts:(BatchReceipt|null|undefined)[];replication:{running:boolean;error:string}}>}).compositionDelivery(expected,mode),{expected,mode}));
      markFlow(page,mode==='full'?'flush-completed':'delivery-observe-completed');
      lastSample={peerId:value.peerId,replication:value.replication,pendingIds:value.pending.map(record=>record.batch.id),expectedBatchIds:expectedIds,
        receipts:expected.map(({batchId,targetId},index)=>{const receipt=value.receipts[index];return {expectedBatchId:batchId,expectedTargetId:targetId,presence:receipt===undefined?'undefined':receipt===null?'null':'present',actual:receipt==null?null:{id:receipt.id,targetId:receipt.targetId,durable:receipt.durable,upload:receipt.upload,importedBy:[...receipt.importedBy]}};}),
        conditions:{pendingEmpty:!value.pending.length,replicationIdle:!value.replication.running,allReceiptsDurableForPeer:value.receipts.every(receipt=>receipt?.durable&&receipt.importedBy.includes(value.peerId))}};
      awaitingOperation='delivery-predicates';
      assert.equal(value.replication.error,'');
      if(!value.pending.length&&!value.replication.running&&value.receipts.every(receipt=>receipt?.durable&&receipt.importedBy.includes(value.peerId)))return;
      if(Date.now()>=deadline)throw new Error('exact durable provider delivery deadline exceeded');
      // A completed durable outbox/receipt predicate needs quiescence, not another
      // pass. After actual idle, re-read live evidence; a concurrent new write
      // or missing receipt routes back through the full delivery path.
      next=!value.pending.length&&value.receipts.every(receipt=>receipt?.durable&&receipt.importedBy.includes(value.peerId))?'idle':'full';
      if(next==='full')await new Promise(resolve=>setTimeout(resolve,25));
    }
    }catch(error){
      t.diagnostic(`composition native-rpc evidence: ${JSON.stringify({flowStep,entries:[...nativeRpcEvidence]})}`);
      if(error instanceof Error&&error.message==='exact durable provider delivery deadline exceeded'){
        t.diagnostic(`composition delivery-timeout evidence: ${JSON.stringify({host:new URL(page.url()).searchParams.get('host'),awaitingOperation,lastSample,expectedBatchIds:expectedIds})}`);
      }
      await captureReferenceFailure(t,[page],`delivery-error:${flowStep}`);
      throw error;
    }
  };
  const makePage=async(host:'native'|'web',legacyProfile=false)=>{
    const owner=host==='native'&&options.nativeColdRestart?nativeBrowser!:browser!;
    const context=await owner.newContext({...(!legacyProfile&&host==='native'&&nativeState?{storageState:nativeState}:{}),viewport:{width:1200,height:950},serviceWorkers:'block',hasTouch:options.hasTouch??false});
    await installBrowserDriveBoundary(context,drive,legacyProfile?'legacy-'+host:host);
    const page=await context.newPage();page.setDefaultTimeout(25000);
    if(legacyProfile)legacyPages.push(page);else{pages.push(page);delivery.set(page,()=>deliver(page));}
    page.on('pageerror',error=>{const stack=error.stack??error.message;
      const nativeNavigationRead = host === 'native' && stage === 'reload-native'
        && stack.startsWith(`Fetch API cannot load ${origin}/api/edits/pending-records due to access control checks.`)
        && departingControllers.has(page)
        && stack.includes(`${origin}/src/features/${departingControllers.get(page)}.tsx:`);
      const webNavigationPull = host === 'web' && stage === 'reload-web'
        && stack.startsWith(`Fetch API cannot load ${origin}/composition/pull due to access control checks.`)
        && stack.includes(`${origin}/src/runtime/edits/replication.ts:`);
      const nativeDatasetRead = host === 'native' && stage === 'reload-native'
        && stack.startsWith(`Fetch API cannot load ${origin}/api/edits/dataset-control due to access control checks.`)
        && stack.includes(`${origin}/src/adapters/desktop/editRepository.ts:`)
        && stack.includes(`${origin}/src/runtime/edits/replication.ts:`);
      const nativeCatalogRead = host === 'native' && stage === 'reload-native' && departingControllers.has(page)
        && stack.startsWith(`Fetch API cannot load ${origin}/api/edits/read due to access control checks.`)
        && stack.includes(`at catalog (${origin}/src/features/library/LibrarySession.ts:`);
      const nativeCorpusRead = isCaughtCorpusNavigationError({ engine, host, stage, origin, stack,
        departingController: departingControllers.get(page) });
      const navigationRead = engine === 'webkit' && (nativeCorpusRead
        || stack.includes(`${origin}/e2e/fixtures/documentComposition.tsx:`)
          && (nativeNavigationRead || webNavigationPull || nativeDatasetRead || nativeCatalogRead));
      (navigationRead?navigationDiagnostics:errors).push(`${host} (${stage}): ${stack}`);});
    if(process.env.PAPEER_COMPOSITION_STARTUP_DIAGNOSTICS==='1')page.on('requestfailed',request=>{
      const target=new URL(request.url());
      if(target.origin===new URL(page.url()).origin&&target.pathname.startsWith('/api/edits/'))
        t.diagnostic('composition requestfailed: '+JSON.stringify({host,pathname:target.pathname,method:request.method(),errorText:request.failure()?.errorText.slice(0,256)}));
    });
    page.on('console',message=>{if(message.text().startsWith('composition-unhandled:'))unhandled.push(message.text());if(message.text().startsWith('composition-flush-timing:'))t.diagnostic(message.text());});
    page.on('request',request=>{const url=request.url(),pathname=new URL(url).pathname;if(/\/(?:Legacy[^/]*|inkStore|annotations|store|migrateStorage)\.[jt]sx?(?:\?|$)/.test(url))forbidden.push(url);
      if(contentKind==='markdown'&&!documentModulesAllowed&&['/src/features/reader/PdfPane.tsx','/src/web/PdfReader.tsx','/src/features/reader/DocumentLibraryConnection.tsx'].includes(pathname))forbidden.push(url);
      if(pathname.startsWith('/api/')&&!pathname.startsWith('/api/edits/'))forbidden.push(url);});
    await page.addInitScript(legacy=>{window.addEventListener('unhandledrejection',event=>console.error('composition-unhandled:'+String(event.reason)));if(legacy&&localStorage.getItem('paperdesk-draft-sentinel')===null)localStorage.setItem('paperdesk-draft-sentinel','untouched raw draft');const opened:string[]=[];Object.assign(window,{compositionOpenedDatabases:opened});const open=indexedDB.open.bind(indexedDB);indexedDB.open=(name,version)=>{opened.push(name);return open(name,version);};},legacyProfile);
    const source=(legacyProfile?'legacy-':'')+host;
    if(startupTiming){
      const counters={started:0,finished:0,failed:0,lastFinishedAtMs:0};pageRequests.set(page,counters);
      page.on('request',()=>{counters.started++;});
      page.on('requestfinished',()=>{counters.finished++;counters.lastFinishedAtMs=Date.now()-flowStartedEpoch;});
      page.on('requestfailed',()=>{counters.failed++;});
      page.once('domcontentloaded',()=>markStartup(source,'event.domcontentloaded'));page.once('load',()=>markStartup(source,'event.load'));
      page.on('console',message=>{if(/vite/i.test(message.text()))markStartup(source,'console.vite',{text:message.text().slice(0,160)});});
    }
    markStartup(source,'goto.before');
    await page.goto(origin+`/e2e/fixtures/documentComposition.html?host=${host}${process.env.PAPEER_COMPOSITION_STARTUP_DIAGNOSTICS==='1'?'&startupDiagnostics=1':''}`);
    if(startupTiming){
      const clock=await page.evaluate(()=>({timeOrigin:performance.timeOrigin,pageNowMs:Math.round(performance.now()),visibility:document.visibilityState,focused:document.hasFocus()})).catch(()=>null);
      markStartup(source,'goto.after',{clock});
    }
    return page;
  };
  let authEndpointReady=false;
  const authNetworkEvidence=async()=>{
    const deadline=Date.now()+20000,firstReady=!authEndpointReady;let refused=0;
    if(firstReady)markStartup('native-api','auth-evidence.first-request');
    for(;;){
      let response:Response;
      try{response=await fetch(`http://127.0.0.1:${port}/composition/auth-evidence`,{headers:{'Authorization':'Bearer '+token},signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});}
      catch(error){
        // The owned child prints its port before Uvicorn begins accepting connections.
        const cause=(error as {cause?:{code?:string}}).cause;
        if(authEndpointReady||cause?.code!=='ECONNREFUSED'||Date.now()>=deadline)throw error;
        refused++;await new Promise(resolve=>setTimeout(resolve,50));continue;
      }
      assert.ok(response.ok);const value=await response.json() as {browserOpened:number;driveRequests:number};authEndpointReady=true;
      if(firstReady)markStartup('native-api','auth-evidence.first-ok',{connectionRefusedBeforeOk:refused});
      return {browserOpened:value.browserOpened,driveRequests:value.driveRequests};
    }
  };
  const assertCanonicalDraftsAbsent=async(page:Page)=>assert.deepEqual(await page.evaluate(()=>[localStorage.getItem('paperdesk-draft-sentinel'),localStorage.getItem('papeer-draft-sentinel')]),[null,null]);
  const makeCanonicalPage=async(host:'native'|'web')=>{
    const expectedError=host==='native'?'Error: hold-active':'Error: legacy-data-present';
    const before=host==='native'?await authNetworkEvidence():undefined;
    if(host==='native')assert.deepEqual(before,{browserOpened:0,driveRequests:0});
    const retained=await makePage(host,true);
    await retained.waitForFunction(error=>{const read=(window as unknown as {compositionBootstrapStatus?:()=>{state:{phase:string;error:string}}}).compositionBootstrapStatus;return read?.().state.phase==='recovery-required'&&read().state.error===error;},expectedError);
    if(host==='native')assert.deepEqual(await authNetworkEvidence(),before,'legacy hold must precede Native OAuth and Drive traffic');
    // Native bridge traffic shares its process label; its initial no-OAuth proof is above.
    if(host==='web')assert.deepEqual(Object.keys(drive.calls).filter(key=>key.startsWith('legacy-web:')),[]);
    assert.equal(await retained.evaluate(()=>(window as unknown as {fixtureGesture?:boolean}).fixtureGesture),undefined);
    const page=await makePage(host);legacyDraftPages.set(page,{page:retained,error:expectedError});
    await readLegacyDraftEvidence(page);await assertCanonicalDraftsAbsent(page);return page;
  };
  const restartNative=async()=>{
    assert.ok(options.nativeColdRestart&&nativeBrowser,'owned cold Native fixture required');
    const old=pages.find(page=>new URL(page.url()).searchParams.get('host')==='native');assert.ok(old&&!old.isClosed());
    const outcome=await old.evaluate(()=>(window as unknown as {compositionClose():Promise<ScopeLeaveResult>}).compositionClose());
    if(outcome.status!=='allowed'){
      assert.fail('normal host refused; no restart bypass: '+sanitizeNativeCloseReason(outcome.reason,token));
    }
    nativeState=await old.context().storageState();
    const previousToken=token,previousLease=lastIssuedLease;
    for(let index=pages.length-1;index>=0;index--)if(pages[index].context().browser()===nativeBrowser)pages.splice(index,1);
    for(let index=legacyPages.length-1;index>=0;index--)if(legacyPages[index].context().browser()===nativeBrowser)legacyPages.splice(index,1);
    await nativeBrowser.close();await shutdown();assert.ok(child!.exitCode!==null||child!.signalCode!==null);
    token=crypto.randomUUID();config.loopbackToken=token;lastIssuedLease=undefined;
    await startNativeProcess('resume');authEndpointReady=false;await authNetworkEvidence();
    const oldBearer=await nativeCall('/api/edits/bootstrap/local-context/read',{}, {'Authorization':'Bearer '+previousToken,'Content-Type':'application/json'});
    assert.ok([401,403].includes(oldBearer.status));
    assert.ok(previousLease,'actual prior API lease must have been observed');
    const oldLease=await nativeCall('/api/edits/bootstrap/discover',{}, {'Authorization':'Bearer '+token,'X-Papeer-Host-Lease':previousLease,'Content-Type':'application/json'});
    assert.equal(oldLease.status,403,'fresh actual authority refuses the old lease');
    nativeBrowser=await launchBrowser();const page=await makeCanonicalPage('native');
    pages.splice(pages.indexOf(page),1);pages.unshift(page);
    native=page;
    nativeRestartWitnesses.push({generation:nativeGeneration,bearerRotated:token!==previousToken,oldBearerRefused:true,oldLeaseRefused:true});
    return page;
  };
  markStartup('flow','native-canonical-page.before');let native=await makeCanonicalPage('native');markStartup('native','canonical-page.after');await connect(native,true);
  type Base={scope:EditScope;root:LibrarySnapshot;head:string};
  const base=await native.evaluate(()=>(window as unknown as {compositionSeedBase():Promise<Base>}).compositionSeedBase());
  const scope=base.scope,namespace=createHash('sha256').update(scopeKey(scope)).digest('hex');
  const descriptorFiles=[...drive.files.values()].filter(file=>file.properties?.papeer==='canonical-provider-v1'
    &&file.properties.providerKind==='descriptor'&&file.properties.scope===namespace);
  assert.equal(descriptorFiles.length,1,'actual admitted scope has one provider descriptor');
  assert.deepEqual((JSON.parse(descriptorFiles[0].body) as {scope:EditScope}).scope,scope);
  assert.equal(descriptorFiles[0].parents?.length,1);const parentId=descriptorFiles[0].parents![0];
  const resources=()=>collectCompositionResources(drive.files,namespace,parentId);
  // Synthetic third peer publishes only the normal immutable provider envelope.
  // No renderer RPC or local Core receive/receipt authority is exposed.
  const publishThirdPeerRecord=async(record:EditRecord)=>{
    const stable=structuredClone(record);assertEditRecord(stable);assert.equal(stable.batch.libraryId,scope.libraryId);
    assert.ok(stable.batch.targetId===scope.libraryId||publications.some(value=>value.content?.id===stable.batch.targetId),'known canonical target required');
    assert.ok(!records().some(value=>value.batch.id===stable.batch.id),'third-peer publication is a new immutable operation');
    const headers={Authorization:'Bearer fixture-third-peer-only'};
    const allocated=await drive.request({url:'https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files',method:'GET',headers,bodyBase64:''},'third-peer');
    assert.equal(allocated.status,200);const ids=(JSON.parse(Buffer.from(allocated.bodyBase64,'base64').toString('utf8')) as {ids:string[]}).ids;
    assert.equal(ids.length,1);assert.ok(ids[0]);
    const metadata={id:ids[0],name:stable.batch.id+'.json',mimeType:'application/json',parents:[parentId],
      properties:{papeer:'edits-v1',scope:namespace,editKind:'edit-record',objectId:stable.batch.id}};
    const raw=canonicalJson({kind:'edit-record',record:stable});assert.ok(Buffer.byteLength(raw)>0&&Buffer.byteLength(raw)<=16*1024*1024);
    const boundary='composition-third-peer-'+crypto.randomUUID();
    const multipart=Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+raw+'\r\n--'+boundary+'--\r\n');
    const uploaded=await drive.request({url:'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',method:'POST',
      headers:{...headers,'Content-Type':'multipart/related; boundary='+boundary},bodyBase64:multipart.toString('base64')},'third-peer');
    assert.equal(uploaded.status,200);assert.equal((JSON.parse(Buffer.from(uploaded.bodyBase64,'base64').toString('utf8')) as {id:string}).id,ids[0]);
    const read=await drive.request({url:'https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(ids[0])+'?alt=media',method:'GET',headers,bodyBase64:''},'third-peer');
    assert.equal(read.status,200);assert.equal(Buffer.from(read.bodyBase64,'base64').toString('utf8'),raw);
    return {status:uploaded.status};
  };
  // Readonly provider evidence for a real private replica's acknowledgement.
  const hasRemoteImportReceipt=(batchId:string,peerId:string)=>{
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    assert.match(batchId,uuid);assert.match(peerId,uuid);let found=false;
    for(const file of drive.files.values()){
      if(file.properties?.papeer!=='edits-v1'||file.properties.editKind!=='import-receipt')continue;
      assert.equal(file.properties.scope,namespace);assert.deepEqual(file.parents,[parentId]);assert.equal(file.mimeType,'application/json');
      assert.match(file.id,/^[A-Za-z0-9_-]+$/);assert.match(file.version,/^[1-9][0-9]*$/);
      assert.equal(file.ownedByMe,true);assert.equal(file.trashed,false);assert.equal(file.capabilities.canEdit,true);assert.equal(file.capabilities.canDownload,true);
      assert.equal(file.size,String(file.bytes.byteLength));assert.ok(Buffer.from(file.body,'utf8').equals(file.bytes),'provider receipt body equals actual bytes');
      const value=JSON.parse(file.body) as {kind:string;batchId:string;peerId:string};
      assert.deepEqual(Object.keys(value).sort(),['batchId','kind','peerId']);assert.equal(value.kind,'import-receipt');
      assert.match(value.batchId,uuid);assert.match(value.peerId,uuid);
      const logicalId=value.batchId+'-'+value.peerId;assert.equal(file.name,'edit-'+logicalId+'.json');
      if(file.properties.objectId!==undefined)assert.equal(file.properties.objectId,logicalId);
      // Native writes sorted canonical JSON; the current Web writer preserves this explicit insertion order.
      assert.ok(file.body===canonicalJson(value)||file.body===JSON.stringify({kind:'import-receipt',batchId:value.batchId,peerId:value.peerId}),'exact supported provider receipt encoding');
      if(value.batchId===batchId&&value.peerId===peerId)found=true;
    }
    return found;
  };
  const setIncomingEditListMode=(page:Page,mode:IncomingEditListMode)=>{
    const client=page===native?'native':page===web?'web':null;
    if(!client)throw new Error('genuine-composition-page-required');
    drive.setIncomingEditListMode(client,mode,{namespace,parentId});
  };
  const call=async(method:string,args:unknown[]=[])=>native.evaluate(({method,args})=>(window as unknown as {compositionRepository(method:string,args:unknown[]):Promise<unknown>}).compositionRepository(method,args),{method,args});
  const repository=new Proxy({scope},{get(target,key){if(key==='scope')return target.scope;return async(...args:unknown[])=>{
    if(key==='storeResource'){const input=args[0] as {bytes:Uint8Array};args=[{...input,bytes:Array.from(input.bytes)}];}
    const value=await call(String(key),args);if(key==='readResource'&&value){const resource=value as {metadata:ResourceMetadata;bytes:number[]};return {...resource,bytes:Uint8Array.from(resource.bytes)};}return value;
  };}}) as ContentRepository;
  publication=structuredClone(fixture.publications.find(value=>value.name==='pdf')!.value);
  // Rebase the complete catalog batch BEFORE callbacks construct citations/additional publications.
  publication.libraryBatch.libraryId=scope.libraryId;publication.libraryBatch.targetId=scope.libraryId;publication.libraryBatch.parents=[base.head];
  assert.equal(publication.content?.kind,'document');if(publication.content?.kind==='document')publication.content.pages.push({...structuredClone(publication.content.pages[0]),id:crypto.randomUUID()});
  let pdfMetadata=fixture.resource.metadata;const pdfBytes=new Uint8Array(fs.readFileSync(path.join(root,'tests/fixtures',options.pdfFixture==='text'?'sample.pdf':fixture.resource.file)));
  if(!options.emptyScope&&options.pdfFixture==='text'){pdfMetadata=await repository.storeResource({id:pdfMetadata.id,sha256:createHash('sha256').update(pdfBytes).digest('hex'),mediaType:'application/pdf',bytes:pdfBytes});assert.ok(pdfMetadata.pdfPages?.length);if(publication.content?.kind==='document')for(const page of publication.content.pages){assert.equal(page.background.kind,'pdf');if(page.background.kind!=='pdf')continue;const physical:NonNullable<ResourceMetadata['pdfPages']>[number]=pdfMetadata.pdfPages![page.background.pdfPage-1];assert.ok(physical);page.widthPt=physical.widthPt;page.heightPt=physical.heightPt;page.background.sourceRevision=pdfMetadata.sha256;}}
  seed?.(publication);let item=publication.libraryBatch.changes.find(change=>change.type==='put-item')!;assert.equal(item.type,'put-item');
  contentKind=publicationKind(publication)!;item.item.title=contentKind==='markdown'?'Canonical Markdown composition':item.item.kind==='notebook'?'Canonical notebook composition':'Canonical PDF composition';
  const additional=options.additionalPublications?.(publication);publications.push(publication,...(additional?.publications??[]));
  documentId=additional?.initialDocumentId??publication.content!.id;const initial=publications.find(value=>value.content?.id===documentId)!;assert.ok(initial);contentKind=publicationKind(initial)!;
  item=initial.libraryBatch.changes.find(change=>change.type==='put-item')!;assert.equal(item.type,'put-item');const title=item.item.title;
  const resourceIds=[...new Set(publications.flatMap(publicationResourceIds))];
  if(!options.emptyScope)for(const id of resourceIds){assert.equal(id,pdfMetadata.id,'fixture has verified bytes for resource');assert.deepEqual(await repository.storeResource({...pdfMetadata,bytes:pdfBytes,expected:pdfMetadata}),pdfMetadata);}
  if(!options.emptyScope)for(const value of publications)assert.equal((await repository.publish(value)).status,'durable');
  config.documentId=documentId;config.contentKind=contentKind;config.seededContents=publications.map(value=>({id:value.content!.id,kind:value.content!.kind}));markStartup('flow','seeded');await configure(native);await deliver(native);markStartup('native','seed-delivered');
  const web=await makeCanonicalPage('web');markStartup('web','canonical-page.after');await connect(web);await configure(web);await deliver(web);markStartup('web','seed-delivered');
  // Original wait is unchanged (default 25 s). Under PAPEER_COMPOSITION_STARTUP_TIMING only: snapshots at 5 s and 15 s while waiting, and, after the
  // original wait has already failed, a further 30 s observation (delay vs stall) before the unchanged error is rethrown. The verdict never relaxes.
  const observedWait=async(page:Page,locator:ReturnType<Page['locator']>,name:string)=>{
    if(!startupTiming){await locator.waitFor();return;}
    const host=hostOf(page);markStartup(host,name+'.wait-start');
    const timers=[5000,15000].map(delay=>setTimeout(()=>{void startupSnapshot(page,host,name+'-wait+'+delay+'ms',false);},delay));
    try{await locator.waitFor();}
    catch(error){
      for(const timer of timers)clearTimeout(timer);
      markStartup(host,name+'.wait-failed-at-original-deadline');
      await startupSnapshot(page,host,name+'-failed',true);
      const late=await locator.waitFor({timeout:30000}).then(()=>true,()=>false);
      markStartup(host,name+(late?'.visible-after-original-deadline':'.absent-30s-after-original-deadline'));
      await startupSnapshot(page,host,name+'-30s-after-failure',true);
      throw error;
    }
    for(const timer of timers)clearTimeout(timer);
    markStartup(host,name+'.visible');await startupSnapshot(page,host,name+'-visible',false);
  };
  const openItem=async(page:Page,id:string,waitForContent=true)=>{
    markStartup(hostOf(page),'open-item.start');
    await page.bringToFront();markStartup(hostOf(page),'open-item.brought-to-front');
    assert.ok(publications.some(value=>value.content?.id===id));
    const matches=await page.evaluate(async id=>{
      const state=(await (window as unknown as {
        compositionLibraryEvidence():Promise<{session?:{items:{id:string;title:string}[];deletedItems:{id:string;title:string}[]}}>;
      }).compositionLibraryEvidence()).session;
      return [...(state?.items??[]).filter(item=>item.id===id).map(item=>({...item,deleted:false})),
        ...(state?.deletedItems??[]).filter(item=>item.id===id).map(item=>({...item,deleted:true}))];
    },id);
    assert.equal(matches.length,1,'one actual active or deleted catalog item required');
    const entry=matches[0];assert.equal(entry.id,id);
    const catalog=page.getByRole('button',{name:'\u8cc7\u6599\u4e00\u89a7',exact:true});if(await catalog.getAttribute('aria-expanded')!=='true')await catalog.click();
    const label=entry.deleted?`\u524a\u9664\u3055\u308c\u305f\u300c${entry.title}\u300d\u306e\u5185\u5bb9\u3092\u78ba\u8a8d`:entry.title;
    await page.getByRole('region',{name:'\u8cc7\u6599\u4e00\u89a7',exact:true}).getByRole('button',{name:label,exact:true}).click();
    markStartup(hostOf(page),'open-item.item-clicked');
    if(waitForContent)await observedWait(page,page.locator(`[data-content-document="${id}"]`),'content-document');
  };
  for(const page of pages)if(!options.emptyScope){await openItem(page,documentId);await observedWait(page,page.getByRole('heading',{name:title,exact:true}),'heading');if(contentKind==='markdown')await markdownSync(page);else{if(resourceIds.length)await page.locator('.react-pdf__Page canvas').waitFor();await sync(page);}}
  markStartup('flow','startup-complete');emitStartupTable(t,'startup-complete');
  const observeDeparting=async(page:Page)=>{
    departingControllers.delete(page);let timer:ReturnType<typeof setTimeout>|undefined;
    const kind=await Promise.race([page.evaluate(async()=>{const id=document.querySelector('[data-content-document]')?.getAttribute('data-content-document');return id?(window as unknown as {compositionReadContentKind(id:string):Promise<string|null>}).compositionReadContentKind(id):null;}),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),2000);})]).catch(()=>null).finally(()=>{if(timer!==undefined)clearTimeout(timer);});
    if(kind)departingControllers.set(page,kind==='markdown'?'notes/MarkdownLibraryConnection':'reader/DocumentLibraryConnection');
  };
  const reloadContent=async(page:Page,id:string)=>{
    assert.ok(config.seededContents.some(value=>value.id===id));markFlow(page,'reload.legacy-read.before');await readLegacyDraftEvidence(page);markFlow(page,'reload.legacy-read.after');
    markFlow(page,'reload.observe-departing.before');await observeDeparting(page);markFlow(page,'reload.observe-departing.after');
    stage=page===native?'reload-native':'reload-web';const url=new URL(page.url());url.searchParams.set('initialDocumentId',id);
    markFlow(page,'reload.goto.before');await page.goto(url.href);markFlow(page,'reload.goto.after');await assertCanonicalDraftsAbsent(page);
    markFlow(page,'reload.connect.before');await connect(page);markFlow(page,'reload.connect.after');
    markFlow(page,'reload.configure.before');await configure(page);markFlow(page,'reload.configure.after');
    markFlow(page,'reload.deliver.before');await deliver(page);markFlow(page,'reload.deliver.after');
    markFlow(page,'reload.open-item.before');await openItem(page,id,false);markFlow(page,'reload.open-item.after');
    markFlow(page,'reload.final-legacy-read.before');await readLegacyDraftEvidence(page);markFlow(page,'reload.final-legacy-read.after');stage='active';
  };
  const reload=(page:Page)=>reloadContent(page,documentId);
  // Negative read-failure setup only: caller must assert the real error UI and
  // restore normal delivery after unmasking. This does not claim content delivery.
  const reloadUnavailableContent=async(page:Page)=>{
    const id=documentId;assert.ok(config.seededContents.some(value=>value.id===id));await readLegacyDraftEvidence(page);
    markFlow(page,'reload-unavailable.observe-departing.before');await observeDeparting(page);markFlow(page,'reload-unavailable.observe-departing.after');
    stage=page===native?'reload-native':'reload-web';const url=new URL(page.url());url.searchParams.set('initialDocumentId',id);
    markFlow(page,'reload-unavailable.goto.before');await page.goto(url.href);markFlow(page,'reload-unavailable.goto.after');await assertCanonicalDraftsAbsent(page);
    markFlow(page,'reload-unavailable.connect.before');await connect(page);markFlow(page,'reload-unavailable.connect.after');
    markFlow(page,'reload-unavailable.configure.before');await configure(page);markFlow(page,'reload-unavailable.configure.after');
    const selected=await page.evaluate(()=>(window as unknown as {compositionNavigationEvidence():{navigation:{documentId:string|null}}}).compositionNavigationEvidence().navigation.documentId);
    if(selected!==id)await openItem(page,id,false);
    await page.waitForFunction(id=>(window as unknown as {compositionNavigationEvidence():{navigation:{documentId:string|null}}}).compositionNavigationEvidence().navigation.documentId===id,id,{timeout:25_000});
    await readLegacyDraftEvidence(page);stage='active';
  };

  const nativeAuthEvidence=async()=>{
    const reply=await nativeCall('/composition/auth-evidence',undefined,{'Authorization':'Bearer '+token},'GET');assert.ok(reply.ok);
    return await reply.json() as {browserOpened:number;forgedStateRefused:number;pkceVerified:number;callbackAccepted:number;errors:string[]};
  };
  const finish=async(finishOptions:{offlineFinal?:boolean}={})=>{
    for(const page of pages){await readLegacyDraftEvidence(page);await assertCanonicalDraftsAbsent(page);}
    assert.deepEqual(Object.keys(drive.calls).filter(key=>key.startsWith('legacy-web:')),[]);
    const observations={forbidden,errors,unhandled,navigationDiagnostics};t.diagnostic(`Composition browser observations: ${JSON.stringify(observations)}`);
    assert.equal(fs.readFileSync(database,'utf8'),sentinel);assert.deepEqual(fs.readdirSync(legacy),['library.sqlite3']);assert.ok(fs.statSync(path.join(directory,'.canonical-shared-app/content.sqlite3')).size>0);
    assert.ok(records().every(record=>record.batch&&!('checkpoint'in record)),'ordinary transfer never copies checkpoints');if(!options.emptyScope)assert.ok(imports().length>0);
    const storedResources=resources();let expectedResources=options.emptyScope?[]:resourceIds;
    if(!options.emptyScope&&(options.allowImageResources||options.allowAttachmentResources||additional)){
      const checkpoints=await Promise.all(publications.map(async value=>(await repository.read(value.content!.id)).checkpoint));const catalog=options.allowAttachmentResources?await repository.read(scope.libraryId):undefined;
      expectedResources=[...new Set([...checkpoints.flatMap(checkpoint=>[...snapshotResourceIds(checkpoint.root),...checkpoint.batches.flatMap(batchResourceIds)]),...(catalog?[...snapshotResourceIds(catalog.checkpoint.root),...catalog.checkpoint.batches.flatMap(batchResourceIds)]:[])])].sort();
    }
    const logicalResources=await verifyCompositionResourceClosure(storedResources,expectedResources,id=>repository.readResource(id),
      evidence=>t.diagnostic('Composition physical resource closure: '+JSON.stringify(evidence)));
    if(!options.emptyScope&&(options.allowImageResources||options.allowAttachmentResources||additional)){
      for(const metadata of logicalResources)if(!resourceIds.includes(metadata.id)&&!options.allowAttachmentResources)assert.match(metadata.mediaType,/^image\//);
    }else if(!resourceIds.length||options.emptyScope)assert.deepEqual(resourceCalls,[]);
    for(const page of pages)if(!options.emptyScope){
      await deliver(page);
      const peer=await page.evaluate(()=>(window as unknown as {compositionAdmittedPeer():string}).compositionAdmittedPeer());
      const receipt=await page.evaluate(id=>(window as unknown as {compositionRepository(method:string,args:unknown[]):Promise<{durable:boolean;importedBy:string[]}>}).compositionRepository('receipt',[id]),publication.libraryBatch.id);
      assert.equal(receipt.durable,true);assert.ok(receipt.importedBy.includes(peer));
      assert.ok(imports().some(value=>value.batchId===publication.libraryBatch.id&&value.peerId===peer),'actual private replica acknowledged exact publication for actual admitted peer');
    }
    assert.ok(apiCalls.length>0);assert.ok(apiCalls.every(endpoint=>endpoint.startsWith('/api/edits/')));assertCompositionBrowserObservations(observations);
    const auth=await nativeAuthEvidence();
    if(finishOptions.offlineFinal){assert.equal(auth.pkceVerified,0);assert.deepEqual(await authNetworkEvidence(),{browserOpened:0,driveRequests:0});}
    else assert.ok(auth.pkceVerified>0);
    assert.equal(auth.browserOpened,auth.forgedStateRefused);assert.equal(auth.callbackAccepted,auth.pkceVerified);assert.deepEqual(auth.errors,[]);t.diagnostic('Synthetic provider HTTP/PKCE callback only; actual isolated DPAPI/bootstrap/owner/private replication, not real OAuth or Native GUI.');
    for(const page of [...pages,...legacyPages])assert.equal((await page.evaluate(()=>(window as unknown as {compositionClose():Promise<ScopeLeaveResult>}).compositionClose())).status,'allowed');
    await nativeBrowser?.close();await browser!.close();await server!.close();await shutdown();assert.equal(browser!.isConnected(),false);assert.ok(child!.exitCode!==null||child!.signalCode!==null);
  };
  const holdNextCommitReply=()=>{assert.equal(heldReply,undefined);let received!:(id:string)=>void,release!:()=>void;const receivedPromise=new Promise<string>(resolve=>{received=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});heldReply={received,release,wait};replyReleases.add(release);return{received:receivedPromise,release};};
  const beginContentNavigation=()=>{assert.ok(additional);assert.deepEqual(forbidden,[]);documentModulesAllowed=true;};
  return{native,web,pages,repository,restartNative,nativeNetworkEvidence:authNetworkEvidence,nativeAuthEvidence,setNativeDriveOffline:(value:boolean)=>{nativeDriveOffline=value;},nativeRestartWitnesses:()=>nativeRestartWitnesses.map(value=>({...value})),documentId,publication,publications,publishThirdPeerRecord,hasRemoteImportReceipt,setIncomingEditListMode,beginContentNavigation,reload,reloadContent,reloadUnavailableContent,committed,committedPayloads,finish,holdNextCommitReply,
    browserObservations:()=>({forbidden:[...forbidden],errors:[...errors],unhandled:[...unhandled],navigationDiagnostics:[...navigationDiagnostics]}),published,publishedPayloads,
    /** Read-only copy of every edit record that actually reached the mock Drive (B11: counts of resolution/branch records, not client-side flags). */
    driveRecords:()=>records().map(record=>structuredClone(record)),
    setPublishReplyLoss:(fail:boolean)=>{losePublishReplies=fail;},setCommitReplyLoss:(fail:boolean)=>{loseCommitReplies=fail;},loseNextCommitReply:()=>{loseCommitReply=true;}};
  } catch(error) {
    markStartup('flow','startup-error',{stage});emitStartupTable(t,'startup-error');
    t.diagnostic(`composition startup errors: ${JSON.stringify({stage,errors,unhandled,navigationDiagnostics})}`);
    await captureReferenceFailure(t,pages,`startup:${stage}`);
    await captureReferenceFailure(t,legacyPages,`legacy:${stage}`);throw error;
  }
}
