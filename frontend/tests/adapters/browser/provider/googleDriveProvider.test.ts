import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleDriveProviderHost } from '../../../../src/adapters/browser/provider/googleDriveProvider.ts';
import { canonicalJson } from '../../../../src/runtime/edits/editModel.ts';
import { resourceHash } from '../../../../src/runtime/edits/contentPublication.ts';
import { googleDrivePrincipalDigest } from '../../../../src/runtime/edits/provider/providerPrincipal.ts';
import { DriveSession } from '../../../../src/web/drive.ts';

function boundary(t: { after(fn: () => void | Promise<void>): void }, expectedRedirect: RequestRedirect = 'error') {
 const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousFetch = globalThis.fetch, storage = new Map<string, string>();
 const requests: { method: string; path: string }[] = [], files = new Map<string, { metadata: Record<string, unknown>; bytes: Uint8Array }>();
 let permissionId = 'fixture-permission-A', denied = '', deniedAbout = false, swapVersion = false, listLag = false;
 const loseReplies = new Set<string>(), created = new Map<string, number>();
 let popupStarted = false;
 Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: {
  getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
 }, google: { accounts: { oauth2: { initTokenClient: (options: { callback(value: unknown): void }) => ({ requestAccessToken() { popupStarted = true;options.callback({ access_token: 'synthetic-not-a-real-token', expires_in: 100 }); } }) } } } } });
 const metadata = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: 'Human Library 日本語', mimeType: 'application/json', version: '9007199254740993',
  size: '1', ownedByMe: true, trashed: false, capabilities: { canEdit: true, canDownload: true }, parents: ['folder'], properties: { papeer: 'canonical-provider-v1', providerKind: 'descriptor' }, ...extra });
 files.set('folder', { metadata: metadata('folder', { name: 'Human Library 日本語', mimeType: 'application/vnd.google-apps.folder', properties: {} }), bytes: new Uint8Array() });
 globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));assert.equal(url.origin, 'https://www.googleapis.com');
  assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-not-a-real-token');assert.equal(init?.redirect, expectedRedirect);
  const method = init?.method ?? 'GET';requests.push({ method, path: url.pathname });
  if (url.pathname.endsWith('/about') && deniedAbout) return new Response('', {status:403});
  if (url.pathname.endsWith('/about')) return Response.json({ user: { permissionId } });
  if (url.pathname.endsWith('/generateIds')) return Response.json({ ids: ['generated-folder', 'generated-checkpoint', 'generated-manifest', 'generated-descriptor'].slice(0, Number(url.searchParams.get('count'))) });
  if (url.pathname.endsWith('/files') && method === 'GET') return Response.json({ files: listLag ? [] : [...files].filter(([, value]) => value.metadata.properties && (value.metadata.properties as Record<string, string>).papeer === 'canonical-provider-v1').map(([id, value]) => ({ id, name: value.metadata.name })) });
  if (method === 'POST') {
   let value: Record<string, unknown>, bytes: Uint8Array;
   if (new Headers(init?.headers).get('Content-Type')?.includes('multipart/')) {
    const text = init?.body instanceof Blob ? await init.body.text() : String(init?.body), marker = String(new Headers(init?.headers).get('Content-Type')).split('boundary=')[1];
    const parts = text.split('--' + marker).filter(part => part.includes('Content-Type:'));
    value = JSON.parse(parts[0].split('\r\n\r\n')[1].trim());bytes = new TextEncoder().encode(parts[1].split('\r\n\r\n')[1].replace(/\r\n$/, ''));
   } else { value = JSON.parse(String(init?.body));bytes = new Uint8Array(); }
   const id = typeof value.id === 'string' ? value.id : 'synthetic-upload-' + created.size;if (files.has(id)) return new Response('', { status: 409 });
   files.set(id, { metadata: metadata(id, { ...value, size: String(bytes.length) }), bytes });created.set(id, (created.get(id) ?? 0) + 1);
   if (loseReplies.delete(id)) throw new TypeError('synthetic accepted POST reply lost');return Response.json({ id });
  }
  const fileId = url.pathname.split('/').pop()!, value = files.get(fileId);
  if (denied === fileId) return new Response('', { status: 403 });if (!value) return new Response('', { status: 404 });
  if (url.searchParams.get('alt') === 'media') {
   if (swapVersion) value.metadata.version = '9007199254740994';return new Response(Uint8Array.from(value.bytes));
  }
  return Response.json(value.metadata);
 };
 t.after(() => { globalThis.fetch = previousFetch;if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);else Reflect.deleteProperty(globalThis, 'window'); });
 return { requests, files, loseReplies, created, metadata, popupStarted: () => popupStarted,
  permission: (value: string) => { permissionId = value; }, deny: (fileId = 'descriptor') => { denied = fileId; }, denyAbout: () => { deniedAbout = true; }, versionRace: () => { swapVersion = true; }, lag: () => { listLag = true; } };
}
async function descriptor() {
 const scope = { accountId: crypto.randomUUID(), libraryId: crypto.randomUUID(), epoch: crypto.randomUUID() };
 return { scope, bytes: new TextEncoder().encode(canonicalJson({ version: 1, scope, manifestId: crypto.randomUUID(), checkpointSha256: 'b'.repeat(64) })) };
}

test('fixed Google factory verifies actual HTTP owner/version/bytes and rejects UUID scope rebinding', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const connection = host.connect({}, signal);assert.equal(http.popupStarted(), true, 'GIS popup must start before first await');const principal = await connection;
 assert.equal(principal.digest, await googleDrivePrincipalDigest('fixture-permission-A'));
 const value = await descriptor();http.files.set('descriptor', { metadata: http.metadata('descriptor', { size: String(value.bytes.length), sha256Checksum: await resourceHash(value.bytes) }), bytes: value.bytes });
 assert.deepEqual(await host.list(signal), [{ id: 'descriptor', title: 'Human Library 日本語' }]);
 const verified = await host.verifier.descriptor(principal, 'descriptor', signal);assert.deepEqual(verified.scope, value.scope);assert.equal(verified.version, '9007199254740993');
 assert.deepEqual(await host.verifier.descriptorBytes!(principal, 'descriptor', signal), value.bytes);
 const receiver = host.boundStorage(), before = http.requests.length;await assert.rejects(receiver.bindAccount(value.scope.accountId), /rebinding-forbidden/);assert.equal(http.requests.length, before);
 http.versionRace();await assert.rejects(host.verifier.descriptor(principal, 'descriptor', signal), /version-changed/);
});

test('principal about HTTP403 invalidates the authenticated lifetime', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const principal = await host.connect({}, signal);http.denyAbout();await assert.rejects(host.verifier.current(signal), /403/);assert.throws(() => host.verifier.assertCurrent!(principal));
});

test('file-specific HTTP403 does not sign out other valid descriptor choices', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const principal = await host.connect({}, signal), value = await descriptor();
 for (const fileId of ['descriptor', 'valid']) http.files.set(fileId, {metadata:http.metadata(fileId, {size:String(value.bytes.length)}),bytes:value.bytes});
 http.deny();await assert.rejects(host.verifier.descriptor(principal, 'descriptor', signal), /403/);
 host.verifier.assertCurrent!(principal);assert.equal((await host.list(signal)).length, 2);assert.deepEqual((await host.verifier.descriptor(principal, 'valid', signal)).scope,value.scope);
});

test('explicit account switch issues a different principal lifetime without reviving the old authenticated receiver', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const before = await host.connect({}, signal), oldStorage = host.boundStorage();http.permission('fixture-permission-B');
 const after = await host.connect({ selectAccount: true }, signal);assert.notEqual(after.generation, before.generation);assert.notEqual(after.digest, before.digest);
 assert.equal(after.digest, await googleDrivePrincipalDigest('fixture-permission-B'));assert.throws(() => oldStorage.assertCurrent());assert.throws(() => host.verifier.assertCurrent!(before));
});

test('actual HTTP ownership and capabilities are checked before descriptor bytes are read', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const value = await descriptor(), ordinaryFetch = globalThis.fetch;let bodies = 0;
 globalThis.fetch = async (input, init) => { if (new URL(String(input)).searchParams.get('alt') === 'media') bodies++;return ordinaryFetch(input, init); };
 for (const patch of [{ ownedByMe: false }, { capabilities: { canEdit: false, canDownload: true } }, { capabilities: { canEdit: true, canDownload: false } }, { driveId: 'shared-drive' }, { trashed: true }]) {
  const principal = await host.connect({}, signal);http.files.set('descriptor', { metadata: http.metadata('descriptor', { size: String(value.bytes.length), ...patch }), bytes: value.bytes });
  await assert.rejects(host.verifier.descriptor(principal, 'descriptor', signal), /owner-write-required/);host.verifier.assertCurrent!(principal);
 }
 assert.equal(bodies, 0);
 http.files.set('valid', {metadata:http.metadata('valid',{size:String(value.bytes.length)}),bytes:value.bytes});
 const principal = await host.verifier.current(signal);assert.deepEqual((await host.verifier.descriptor(principal, 'valid', signal)).scope,value.scope);assert.equal(bodies,1);
});

test('retained real Drive IDs survive accepted-but-lost POST even while list is stale', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal;t.after(() => host.disconnectAndWait());
 await host.connect({}, signal);const ids = await host.allocateFileIds(4, signal);assert.equal(new Set(ids).size, 4);http.lag();
 const logicalFolder = crypto.randomUUID();http.loseReplies.add(ids[0]);
 await assert.rejects(host.createFolder(ids[0], logicalFolder, 'Second host human title 日本語', undefined, signal), /reply lost/);
 const folder = await host.createFolder(ids[0], logicalFolder, 'Second host human title 日本語', undefined, signal);assert.equal(folder.id, ids[0]);assert.equal(http.created.get(ids[0]), 1);
 const value = await descriptor(), logicalDescriptor = crypto.randomUUID();http.loseReplies.add(ids[3]);
 await assert.rejects(host.writeDescriptor(ids[3], logicalDescriptor, folder.id, 'Second host human title 日本語', value.bytes, 'a'.repeat(64), signal), /reply lost/);
 const written = await host.writeDescriptor(ids[3], logicalDescriptor, folder.id, 'Second host human title 日本語', value.bytes, 'a'.repeat(64), signal);
 assert.equal(written.id, ids[3]);assert.equal(written.sha256, await resourceHash(value.bytes));assert.equal(http.created.get(ids[3]), 1);
 assert.equal(http.requests.filter(request => request.method === 'POST' && request.path.endsWith('/files')).length, 4, 'two attempts each, same immutable IDs');
 const actual = http.files.get(ids[3])!;assert.equal(actual.metadata.name, 'Second host human title 日本語');
 assert.equal((actual.metadata.properties as Record<string, string>).objectId, logicalDescriptor);
 assert.equal(Object.values(actual.metadata.properties as Record<string, string>).includes('Second host human title 日本語'), false, 'human title is not a custom property');
});

test('configured token expiry invalidates provider generation synchronously without another HTTP request', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal;t.after(() => host.disconnectAndWait());
 t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
 const principal = await host.connect({}, signal);let invalidated = false;const unsubscribe = host.verifier.subscribeInvalidation!(() => { invalidated = true; });t.after(unsubscribe);
 const before = http.requests.length;t.mock.timers.tick(100_001);assert.equal(invalidated, true);
 assert.throws(() => host.verifier.assertCurrent!(principal));await assert.rejects(host.verifier.current(signal));assert.equal(http.requests.length, before);
});

test('disconnect aborts an actual pending fetch body and drains it before releasing the configured receiver', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const principal = await host.connect({}, signal), value = await descriptor();http.files.set('descriptor', { metadata: http.metadata('descriptor', { size: String(value.bytes.length) }), bytes: value.bytes });
 const ordinaryFetch = globalThis.fetch;let entered!: () => void;const pendingBody = new Promise<void>(resolve => { entered = resolve; });
 globalThis.fetch = async (input, init) => {
  if (new URL(String(input)).searchParams.get('alt') === 'media') return new Response(new ReadableStream<Uint8Array>({ start(controller) {
   const abort = () => controller.error(new DOMException('synthetic fetch body aborted', 'AbortError'));
   init?.signal?.addEventListener('abort', abort, { once: true });entered();
  } }));
  return ordinaryFetch(input, init);
 };
 const reading = host.verifier.descriptor(principal, 'descriptor', signal);await pendingBody;
 const disconnected = host.disconnectAndWait();await assert.rejects(reading);await disconnected;
 assert.throws(() => host.verifier.assertCurrent!(principal));
});

test('nested legacy account receiver remains pinned to the original actual credential generation', async t => {
 const http = boundary(t, 'follow'), session = new DriveSession();t.after(() => session.signOutAndWait());await session.signIn();
 const once = await session.bindAccount('fixture-permission-A'), twice = await once.bindAccount('fixture-permission-A');session.signOut();
 const count = http.requests.length;await assert.rejects(Promise.resolve().then(() => twice.assertCurrent()));
 await assert.rejects(twice.sharedEditFiles('a'.repeat(64)));assert.equal(http.requests.length, count);
});


test('descriptor body rejects noncanonical bytes, wrong hash and oversize before authority use', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const value = await descriptor();
 for (const bad of ['noncanonical', 'hash', 'size']) {
  const principal = await host.connect({}, signal);
  const bytes = bad === 'noncanonical' ? new TextEncoder().encode(new TextDecoder().decode(value.bytes) + ' ') : value.bytes;
  http.files.set('descriptor', {metadata: http.metadata('descriptor', {size: bad === 'size' ? '4097' : String(bytes.length), sha256Checksum: bad === 'hash' ? '0'.repeat(64) : await resourceHash(bytes)}), bytes});
  await assert.rejects(host.verifier.descriptor(principal, 'descriptor', signal));
 }
});


test('method-entry lifetime cannot borrow reconnected same-principal credentials across a digest await', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const digest = crypto.subtle.digest.bind(crypto.subtle), previous = crypto.subtle.digest;
 t.after(() => { crypto.subtle.digest = previous; });
 const value = await descriptor();http.files.set('descriptor', {metadata: http.metadata('descriptor', {size: String(value.bytes.length)}), bytes: value.bytes});
 let principal: Awaited<ReturnType<typeof host.verifier.current>>;
 for (const action of [
  () => host.verifier.current(signal),
  () => host.createFolder('old-folder', crypto.randomUUID(), 'Old lifetime', undefined, signal),
  () => host.writeDescriptor('old-descriptor', crypto.randomUUID(), 'folder', 'Old lifetime', value.bytes, 'a'.repeat(64), signal),
  () => host.writeImmutableJson('old-manifest', 'a'.repeat(64), 'folder', crypto.randomUUID(), 'dataset-manifest', {}, signal),
  () => host.list(signal),
  () => host.verifier.descriptor(principal, 'descriptor', signal),
 ]) {
  principal = await host.connect({}, signal);
  let entered!: () => void, release!: () => void, armed = true;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  crypto.subtle.digest = async (algorithm, data) => { if (armed) { armed = false;entered();await held; }return digest(algorithm, data); };
  const old = action(), rejected = assert.rejects(old);await pending;await host.disconnectAndWait();
  const renewed = await host.connect({}, signal);assert.equal(renewed.digest, principal.digest);assert.notEqual(renewed.generation, principal.generation);
  const posts = http.requests.filter(row => row.method === 'POST').length;release();await rejected;
  assert.equal(http.requests.filter(row => row.method === 'POST').length, posts);
  host.verifier.assertCurrent!(renewed);
 }
});


test('owned held pull cancels promptly without signing out or canceling another scope', { timeout: 3000 }, async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), ordinary = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const principal = await host.connect({}, ordinary), group = new AbortController(), other = new AbortController();
 let invalidations = 0;t.after(host.verifier.subscribeInvalidation!(() => { invalidations++; }));
 const original = globalThis.fetch;let entered!: () => void;const held = new Promise<void>(resolve => { entered = resolve; });
 globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));if (url.searchParams.get('q')?.includes('a'.repeat(64))) {
   entered();return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('held pull canceled', 'AbortError')), {once:true}));
  }return original(input, init);
 };
 const canceled = host.boundStorage(() => group.signal), independent = host.boundStorage(() => other.signal);
 const reading = canceled.sharedEditFiles('a'.repeat(64)), rejected = assert.rejects(reading, {name:'AbortError'});await held;
 group.abort();await rejected;assert.equal(invalidations,0);assert.throws(() => canceled.assertCurrent(), {name:'AbortError'});
 independent.assertCurrent();assert.deepEqual(await independent.sharedEditFiles('b'.repeat(64)),[]);
 assert.deepEqual(await host.verifier.current(ordinary),principal);assert.ok(http.requests.length > 0);
});

test('a chained storage operation snapshots old group once and cannot borrow resumed group', { timeout: 3000 }, async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), ordinary = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const principal = await host.connect({}, ordinary), old = new AbortController();let current = old, getters = 0;
 const storage = host.boundStorage(() => { getters++;return current.signal; });
 let entered!: () => void;const held = new Promise<void>(resolve => { entered = resolve; }), original = globalThis.fetch;
 let additions = 0, removals = 0;const add = old.signal.addEventListener.bind(old.signal), remove = old.signal.removeEventListener.bind(old.signal);
 old.signal.addEventListener = (...args: Parameters<typeof add>) => { additions++;return add(...args); };
 old.signal.removeEventListener = (...args: Parameters<typeof remove>) => { removals++;return remove(...args); };
 globalThis.fetch = async (input, init) => {
  if (new URL(String(input)).searchParams.get('q')?.includes('edits-resource-v1') && !old.signal.aborted) {
   entered();return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('probe canceled', 'AbortError')), {once:true}));
  }return original(input, init);
 };
 const bytes = new TextEncoder().encode('scope resource'), metadata = {id:crypto.randomUUID(),mediaType:'text/plain',byteLength:bytes.length,sha256:await resourceHash(bytes)};
 const writing = storage.saveSharedResource('a'.repeat(64),'folder',{metadata,bytes}), rejected = assert.rejects(writing,{name:'AbortError'});await held;
 current = new AbortController();old.abort();await rejected;
 assert.equal(getters,1);assert.equal(additions,removals);assert.equal(http.requests.filter(row=>row.method==='POST').length,0);
 assert.deepEqual(await storage.sharedEditFiles('a'.repeat(64)),[]);assert.equal(getters,2);host.verifier.assertCurrent!(principal);
});

test('accepted upload with lost canceled response rejects success and retries identical logical payload', { timeout: 3000 }, async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), ordinary = new AbortController().signal;t.after(() => host.disconnectAndWait());
 const principal = await host.connect({},ordinary);let group = new AbortController();const storage = host.boundStorage(()=>group.signal);
 const original = globalThis.fetch;let entered!:()=>void, hold = true;const held = new Promise<void>(resolve=>{entered=resolve;});
 globalThis.fetch = async (input,init)=>{
  const response = await original(input,init);
  if (init?.method==='POST' && hold) {hold=false;entered();return new Promise<Response>((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(new DOMException('accepted reply canceled','AbortError')),{once:true}));}
  return response;
 };
 const batchId=crypto.randomUUID(),peerId=crypto.randomUUID(),value={kind:'import-receipt',batchId,peerId},logical=batchId+'-'+peerId;
 const upload=storage.saveSharedEdit('a'.repeat(64),'folder',logical,value),rejected=assert.rejects(upload,{name:'AbortError'});await held;
 group.abort();await rejected;host.verifier.assertCurrent!(principal);
 const accepted=[...http.files.values()].filter(row=>row.metadata.properties && (row.metadata.properties as Record<string,string>).papeer==='edits-v1');
 assert.equal(accepted.length,1);assert.deepEqual(JSON.parse(new TextDecoder().decode(accepted[0].bytes)),value);
 group=new AbortController();await storage.saveSharedEdit('a'.repeat(64),'folder',logical,value);
 const retried=[...http.files.values()].filter(row=>row.metadata.properties && (row.metadata.properties as Record<string,string>).papeer==='edits-v1');
 assert.equal(retried.length,2);for(const row of retried)assert.deepEqual(JSON.parse(new TextDecoder().decode(row.bytes)),value);
 // This adapter has no outbox writer. The engine-owned receipt/outbox checks are separate.
});

test('owner probes and response-body reads respect their owned signal without revoking credentials', { timeout: 3000 }, async t => {
 const http=boundary(t),host=createGoogleDriveProviderHost(),ordinary=new AbortController().signal;t.after(()=>host.disconnectAndWait());
 const principal=await host.connect({},ordinary),value=await descriptor();http.files.set('descriptor',{metadata:http.metadata('descriptor',{size:String(value.bytes.length)}),bytes:value.bytes});
 const original=globalThis.fetch;
 for(const body of [false,true]){
  const group=new AbortController();let entered!:()=>void;const held=new Promise<void>(resolve=>{entered=resolve;});
  globalThis.fetch=async(input,init)=>{
   const url=new URL(String(input));
   if((!body && url.pathname.endsWith('/about')) || (body && url.searchParams.get('alt')==='media')){
    if(!body){entered();return new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new DOMException('owner probe canceled','AbortError')),{once:true}));}
    return new Response(new ReadableStream<Uint8Array>({start(controller){init!.signal!.addEventListener('abort',()=>controller.error(new DOMException('body canceled','AbortError')),{once:true});entered();}}));
   }return original(input,init);
  };
  const request=body?host.verifier.descriptor(principal,'descriptor',group.signal):host.verifier.current(group.signal),rejected=assert.rejects(request,{name:'AbortError'});await held;group.abort();await rejected;
  host.verifier.assertCurrent!(principal);
 }
 globalThis.fetch=original;assert.deepEqual(await host.verifier.current(ordinary),principal);
});


test('successful multi-request resource publication consults owned group exactly once', async t => {
 const http=boundary(t),host=createGoogleDriveProviderHost(),signal=new AbortController().signal;t.after(()=>host.disconnectAndWait());
 await host.connect({},signal);const group=new AbortController();let getters=0;
 const storage=host.boundStorage(()=>{getters++;return group.signal;});const bytes=new TextEncoder().encode('multi request');
 const metadata={id:crypto.randomUUID(),mediaType:'text/plain',byteLength:bytes.length,sha256:await resourceHash(bytes)};
 const before=http.requests.length;await storage.saveSharedResource('a'.repeat(64),'folder',{metadata,bytes});
 assert.equal(getters,1);assert.equal(http.requests.length-before,3);assert.equal(http.requests.slice(before).filter(row=>row.method==='POST').length,2);
});

test('large resources over 4 MiB use chunked resumable upload, handle 308, reject foreign Location, and support abort', async t => {
 const http = boundary(t), host = createGoogleDriveProviderHost(), signal = new AbortController().signal; t.after(() => host.disconnectAndWait());
 await host.connect({}, signal);
 const bytes = new Uint8Array(8 * 1024 * 1024 + 16);
 for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 0xff;
 const metadata = { id: crypto.randomUUID(), mediaType: 'application/pdf', byteLength: bytes.length, sha256: await resourceHash(bytes) };
 const originalFetch = globalThis.fetch, uploadedChunks: Uint8Array[] = [], ranges: string[] = [];
 let badLocation = false, holdSecondChunk = false, enteredSecond!: () => void;
 const heldSecond = new Promise<void>(resolve => { enteredSecond = resolve; });
 globalThis.fetch = async (input, init) => {
  const url = new URL(String(input)), headers = new Headers(init?.headers), method = init?.method ?? 'GET';
  if (method === 'POST' && url.searchParams.get('uploadType') === 'resumable') {
   assert.equal(headers.get('X-Upload-Content-Length'), String(bytes.length));
   assert.equal(headers.get('X-Upload-Content-Type'), 'application/octet-stream');
   if (badLocation) return new Response('', { status: 200, headers: { Location: 'https://evil.example/upload/drive/v3/files?upload_id=bad' } });
   return new Response('', { status: 200, headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=resumable-large' } });
  }
  if (method === 'PUT' && url.searchParams.get('upload_id') === 'resumable-large') {
   const range = headers.get('Content-Range') ?? '';
   ranges.push(range);
   if (holdSecondChunk && uploadedChunks.length === 1) {
    enteredSecond();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('chunk aborted', 'AbortError')), { once: true }));
   }
   const chunk = init?.body instanceof Uint8Array ? init.body : new Uint8Array(await new Response(init?.body).arrayBuffer());
   uploadedChunks.push(chunk);
   const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range); assert.ok(match);
   const end = Number(match[2]), total = Number(match[3]);
   if (end + 1 < total) return new Response('', { status: 308, headers: { Range: `bytes=0-${end}` } });
   const merged = new Uint8Array(total); let offset = 0; for (const part of uploadedChunks) { merged.set(part, offset); offset += part.length; }
   http.files.set('resumable-large', { metadata: http.metadata('resumable-large', { mimeType: 'application/pdf', size: String(total) }), bytes: merged });
   return Response.json({ id: 'resumable-large' });
  }
  return originalFetch(input, init);
 };
 const storage = host.boundStorage(() => signal);
 await storage.saveSharedResource('a'.repeat(64), 'folder', { metadata, bytes });
 assert.deepEqual(ranges, [`bytes 0-${8 * 1024 * 1024 - 1}/${bytes.length}`, `bytes ${8 * 1024 * 1024}-${bytes.length - 1}/${bytes.length}`]);
 assert.equal(http.files.get('resumable-large')?.bytes.length, bytes.length);
 const editRecord = [...http.files.values()].find(row => (row.metadata.properties as Record<string, string>)?.papeer === 'edits-v1');
 assert.ok(editRecord);
 assert.equal(JSON.parse(new TextDecoder().decode(editRecord.bytes)).blobId, 'resumable-large');
 badLocation = true;
 const meta2 = { ...metadata, id: crypto.randomUUID(), sha256: 'c'.repeat(64) };
 await assert.rejects(storage.saveSharedResource('a'.repeat(64), 'folder', { metadata: meta2, bytes }), /drive-upload-session/);
 badLocation = false; uploadedChunks.length = 0; holdSecondChunk = true;
 const group = new AbortController(), scopedStorage = host.boundStorage(() => group.signal);
 const aborted = assert.rejects(scopedStorage.saveSharedResource('a'.repeat(64), 'folder', { metadata: meta2, bytes }), { name: 'AbortError' });
 await heldSecond; group.abort(); await aborted;
});

test('writeDescriptor and writeImmutableJson tolerate post-upload version bump and populated checksum, and captureDescriptor reads once', async t => {
 boundary(t);
 const host = createGoogleDriveProviderHost(), signal = new AbortController().signal; t.after(() => host.disconnectAndWait());
 const principal = await host.connect({}, signal), value = await descriptor();
 const manifestDigest = await resourceHash(new TextEncoder().encode(canonicalJson({})));
 const descriptorDigest = await resourceHash(value.bytes);
 let descriptorGets = 0, manifestGets = 0, tamperChecksum = false;
 const ordinaryFetch = globalThis.fetch;
 globalThis.fetch = async (input, init) => {
  const response = await ordinaryFetch(input, init);
  const url = new URL(String(input)), method = init?.method ?? 'GET';
  if (method === 'GET' && url.searchParams.get('alt') !== 'media' && url.pathname.endsWith('/desc-async')) {
   descriptorGets++;
   const meta = await response.json() as Record<string, unknown>;
   if (descriptorGets === 1) { delete meta.sha256Checksum; meta.version = '1'; }
   else { meta.version = '2'; meta.sha256Checksum = tamperChecksum ? '0'.repeat(64) : descriptorDigest; }
   return Response.json(meta);
  }
  if (method === 'GET' && url.searchParams.get('alt') !== 'media' && url.pathname.endsWith('/man-async')) {
   manifestGets++;
   const meta = await response.json() as Record<string, unknown>;
   if (manifestGets === 1) { delete meta.sha256Checksum; meta.version = '1'; }
   else { meta.version = '2'; meta.sha256Checksum = manifestDigest; }
   return Response.json(meta);
  }
  return response;
 };
 const writtenManifest = await host.writeImmutableJson('man-async', 'a'.repeat(64), 'folder', crypto.randomUUID(), 'dataset-manifest', {}, signal);
 assert.equal(writtenManifest.version, '2');
 assert.equal(writtenManifest.sha256, manifestDigest);
 const descLogicalId = crypto.randomUUID();
 const writtenDescriptor = await host.writeDescriptor('desc-async', descLogicalId, 'folder', 'Human Library', value.bytes, 'a'.repeat(64), signal);
 assert.equal(writtenDescriptor.version, '2');
 assert.equal(writtenDescriptor.sha256, descriptorDigest);
 const captured = await host.verifier.captureDescriptor!(principal, 'desc-async', signal);
 assert.equal(captured.descriptor.version, '2');
 assert.deepEqual(captured.bytes, value.bytes);
 tamperChecksum = true; descriptorGets = 0;
 await assert.rejects(host.writeDescriptor('desc-async', descLogicalId, 'folder', 'Human Library', value.bytes, 'a'.repeat(64), signal), /drive-immutable-changed/);
});
