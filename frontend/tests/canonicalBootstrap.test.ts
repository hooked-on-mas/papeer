import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateCanonicalLibraryProfile, validateCanonicalDevicePeer, type CanonicalInitializeRequest, type DatasetControlRecord, type RepositoryCheckpoint } from '../src/runtime/edits/contracts.ts';
import { admitInitialLibrary, assertInitializationUnchanged, assertCanonicalProfile, type InitialLibraryState } from '../src/runtime/edits/canonicalBootstrap.ts';
import { assertDatasetControlTransition } from '../src/runtime/edits/datasetControl.ts';
import { checkpointHash } from '../src/runtime/edits/datasetManifest.ts';
import { editContentHash } from '../src/runtime/edits/editContentHash.ts';
import { canonicalJson } from '../src/runtime/edits/editModel.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';
const f = JSON.parse(readFileSync(new URL('../../tests/fixtures/canonical-bootstrap.json', import.meta.url), 'utf8'));
const old = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
async function setup() {
  const {initialization: _initialization, origin: _origin, ...profile} = f.profile;
  const checkpoint: RepositoryCheckpoint = {version:1,libraryId:profile.identity.libraryId,roots:[{kind:'library',id:profile.identity.libraryId,version:f.rootVersion,items:[],folders:[],links:[],deletions:[]}],edits:[]};
  const manifest = {version:1 as const,id:f.manifestId,scope:{...profile.identity,epoch:f.epoch},checkpointSha256:await checkpointHash(checkpoint),resources:[]};
  const control: DatasetControlRecord = {version:1,id:f.requestId,identity:profile.identity,epochs:[f.epoch],active:manifest,transition:{id:f.requestId,mode:'initialize',source:null,phase:'activated',publication:{manifest,checkpoint,checkpointObjectId:f.checkpointObjectId}}};
  const request: CanonicalInitializeRequest = {expectedPeerId:f.peer.peerId,profile,control};
  const state: InitialLibraryState = {peer:f.peer,profile:null,control:null,root:null,checkpoint:null,manifest:null,otherLibraryState:false,requestIdUsedByOtherIdentity:false};
  return {request,state};
}
test('metadata and initialization admission', async () => {
  const {request,state} = await setup(), account = f.peer.accountId;
  const made = await admitInitialLibrary(request,account,state); assert.equal(made.kind,'create');
  if (made.kind !== 'create') throw new Error('expected create');
  assert.equal(made.profile.origin.kind,'local-initialize');
  assert.equal(Buffer.byteLength(canonicalJson(request),'utf8'), f.golden.requestJsonUtf8ByteCount);
  assert.equal(await editContentHash(request), f.golden.requestSha256);
  assert.equal(request.control.transition.publication.manifest.checkpointSha256, f.golden.checkpointSha256);
  assert.equal(made.profile.initialization.requestSha256, f.golden.requestSha256);
  const publication = request.control.transition.publication;
  Object.assign(state,{profile:made.profile,control:request.control,root:publication.checkpoint.roots[0],checkpoint:publication.checkpoint,manifest:publication.manifest});
  assert.deepEqual(await admitInitialLibrary(request,account,state),{kind:'retry',receipt:made.receipt});
  const changed = structuredClone(state); changed.profile!.title='renamed'; changed.profile!.remote={kind:'drive',folderId:'folder'}; changed.otherLibraryState=true;
  assertInitializationUnchanged(state.profile!,changed.profile!); assert.deepEqual((await admitInitialLibrary(request,account,changed)).receipt,made.receipt);
  const rotated=structuredClone(changed), current=rotated.control!, initial=structuredClone(current.active!);
  const target=structuredClone(initial); target.id=f.rootVersion; target.scope.epoch='later-epoch';
  current.id=f.manifestId; current.epochs.push('later-epoch'); current.active=target;
  current.transition={id:f.manifestId,mode:'publish',source:initial,phase:'activated',publication:{...structuredClone(publication),manifest:target}};
  assert.deepEqual((await admitInitialLibrary(request,account,rotated)).receipt,made.receipt);
  const altered = structuredClone(request); altered.profile.title='different'; await assert.rejects(admitInitialLibrary(altered,account,state));
  for (const key of ['profile','control','root','checkpoint','manifest'] as const) { const partial=structuredClone(state); partial[key]=null; await assert.rejects(admitInitialLibrary(request,account,partial)); }
  const missingPeer=structuredClone(state); missingPeer.peer=null; await assert.rejects(admitInitialLibrary(request,account,missingPeer));
  const wrongPeer=structuredClone(state); wrongPeer.peer!.peerId=f.manifestId; await assert.rejects(admitInitialLibrary(request,account,wrongPeer));
  const collision=structuredClone(state); collision.requestIdUsedByOtherIdentity=true; await assert.rejects(admitInitialLibrary(request,account,collision));
  await assert.rejects(admitInitialLibrary(request,'other',state));
  for (const invalid of [{...made.profile,title:''},{...made.profile,revision:'bad'},{...made.profile,remote:{kind:'other',folderId:'x'}}]) assert.throws(() => validateCanonicalLibraryProfile(invalid));
  assert.throws(() => validateCanonicalDevicePeer({...f.peer,peerId:'bad'}));
  assert.throws(() => assertDatasetControlTransition(request.control,request.control));
  const bad=structuredClone(request); bad.control.transition.phase='prepared'; await assert.rejects(admitInitialLibrary(bad,account,(await setup()).state));
  const wrongSource=structuredClone(request); wrongSource.control.transition.source=structuredClone(wrongSource.control.transition.publication.manifest); await assert.rejects(admitInitialLibrary(wrongSource,account,(await setup()).state));
  const wrongEpochs=structuredClone(request); wrongEpochs.control.epochs.push('other'); await assert.rejects(admitInitialLibrary(wrongEpochs,account,(await setup()).state));
  const resources=structuredClone(request); resources.control.transition.publication.manifest.resources.push({id:f.rootVersion,sha256:'a'.repeat(64),mediaType:'x',byteLength:1}); await assert.rejects(admitInitialLibrary(resources,account,(await setup()).state));
  const damaged=structuredClone(state); damaged.root!.version=f.manifestId; await assert.rejects(admitInitialLibrary(request,account,damaged));
  const wrongAccount=structuredClone(state); wrongAccount.peer!.accountId='other'; await assert.rejects(admitInitialLibrary(request,account,wrongAccount));
  const peerOnly=(await setup()).state; peerOnly.otherLibraryState=true; await assert.rejects(admitInitialLibrary(request,account,peerOnly));
  const nonempty=structuredClone(request), root=nonempty.control.transition.publication.checkpoint.roots[0];
  if (root.kind !== 'library') throw new Error('expected library');
  root.folders.push({id:f.rootVersion,title:'x',parentId:null,position:0});
  nonempty.control.transition.publication.manifest.checkpointSha256=await checkpointHash(nonempty.control.transition.publication.checkpoint);
  nonempty.control.active=structuredClone(nonempty.control.transition.publication.manifest);
  await assert.rejects(admitInitialLibrary(nonempty,account,(await setup()).state));
});
test('old control sequences remain legal', () => {
  let previous: DatasetControlRecord | undefined;
  for (const control of old.datasetControls.initial as DatasetControlRecord[]) { assertDatasetControlTransition(previous,control); previous=control; }
  previous=old.datasetControls.initial[2];
  for (const control of old.datasetControls.rotation as DatasetControlRecord[]) { assertDatasetControlTransition(previous,control); previous=control; }
});

test('admission snapshots caller inputs across asynchronous hashing', async () => {
  const {request,state}=await setup(), captured=structuredClone(request), capturedState=structuredClone(state);
  const pending=admitInitialLibrary(request,f.peer.accountId,state);
  request.profile.title='mutated'; state.peer!.peerId=f.manifestId;
  const made=await pending; assert.equal(made.kind,'create'); if (made.kind !== 'create') throw new Error('expected create');
  assert.equal(made.profile.title,captured.profile.title);
  const publication=captured.control.transition.publication;
  Object.assign(capturedState,{profile:made.profile,control:captured.control,root:publication.checkpoint.roots[0],checkpoint:publication.checkpoint,manifest:publication.manifest});
  assert.deepEqual((await admitInitialLibrary(captured,f.peer.accountId,capturedState)).receipt,made.receipt);
  made.receipt.identity.accountId='output-mutated'; assert.equal(captured.profile.identity.accountId,f.peer.accountId);
});
test('ordinary repository cannot install an initialize control', async () => {
  const {request}=await setup(), publication=request.control.transition.publication;
  const repository=new DurableEditRepository(publication.manifest.scope,new EditMemoryDatabase(publication.manifest.scope));
  await repository.installDataset(publication.manifest,publication.checkpoint);
  await assert.rejects(repository.replaceDatasetControl(request.control,null), /dataset-initialize-requires-bundle/);
  assert.equal(await repository.datasetControl(),undefined);
});

test('installed profile origin is historical and immutable', () => {
  const profile=structuredClone(f.profile); assertCanonicalProfile(profile);
  const renamed=structuredClone(profile); renamed.title='new'; assertInitializationUnchanged(profile,renamed);
  const changed=structuredClone(profile); changed.origin.installedScope.epoch='later'; assert.throws(() => assertInitializationUnchanged(profile,changed));
  const invalid=structuredClone(profile); invalid.origin.kind='local-initialize'; assert.throws(() => assertCanonicalProfile(invalid));
  const wrong=structuredClone(profile); wrong.origin.installedScope.accountId='other'; assert.throws(() => assertCanonicalProfile(wrong));
});
test('initial request rejects caller-supplied derived origin or proof', async () => {
  const {request,state}=await setup();
  await assert.rejects(admitInitialLibrary({...request,profile:{...request.profile,origin:f.profile.origin}} as unknown as CanonicalInitializeRequest,f.peer.accountId,state));
  await assert.rejects(admitInitialLibrary({...request,profile:{...request.profile,initialization:null}} as unknown as CanonicalInitializeRequest,f.peer.accountId,state));
});
