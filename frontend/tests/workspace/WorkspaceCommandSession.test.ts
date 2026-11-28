import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceCommandSession, type ContentTarget, type WorkspaceOwner } from '../../src/features/workspace/WorkspaceCommandSession.ts';
const doc: ContentTarget = { id: 'document-a', kind: 'markdown' }, other: ContentTarget = { id: 'document-b', kind: 'attachment' };
const scope = { accountId: 'account', libraryId: 'library', epoch: 'one' };
function fixture() {
  let active = true, accepted = true, current: string | null = null, calls = 0;
  const navigation = { scope: { ...scope }, getSnapshot: () => ({ documentId: current }) as ReturnType<import('../../src/features/reader/navigation/ContentNavigationSession.ts').ContentNavigationSession['getSnapshot']>,
    openDocument: async (id: string) => { calls++; current = id; return { status: 'applied' as const }; } };
  const commands = new WorkspaceCommandSession({ navigation, active: () => active, validateTarget: t => accepted && (t.id === doc.id && t.kind === doc.kind || t.id === other.id && t.kind === other.kind) });
  return { commands, navigation, calls: () => calls, active: (value: boolean) => { active = value; }, accepted: (value: boolean) => { accepted = value; } };
}
test('opening delegates once to existing navigation and rejects unavailable, wrong-kind and expired scope', async () => {
  const f=fixture();assert.equal((await f.commands.openContent({ ...doc, kind: 'attachment' })).status,'blocked');assert.equal(f.calls(),0);
  assert.equal((await f.commands.openContent(doc)).status,'applied');assert.equal(f.calls(),1);f.active(false);
  assert.equal((await f.commands.openContent(other)).status,'blocked');f.active(true);f.navigation.scope.epoch='other';
  assert.equal((await f.commands.openContent(other)).status,'blocked');assert.equal(f.calls(),1);
});
test('registered target is frozen, invalid replacement and invalid placement cannot modify current owner', async () => {
  const f=fixture();await f.commands.openContent(doc);let moves=0;
  const mutable: { id:string;kind:ContentTarget['kind'] }={...doc}, identity={};
  f.commands.registerOwner({identity,target:mutable,moveEditor:async()=>{moves++;return true;}});mutable.id=other.id;mutable.kind=other.kind;
  f.commands.registerOwner({identity:{},target:other,moveEditor:async()=>{throw new Error('invalid owner replaced valid');}});
  assert.equal(await f.commands.moveEditor(doc,'right'),true);assert.equal(await f.commands.moveEditor(doc,'invalid' as 'right'),false);assert.equal(moves,1);
  f.commands.releaseOwner(identity);assert.equal(await f.commands.moveEditor(doc,'right'),false);
});
test('same controller readiness registration preserves in-flight ticket; genuine replacement prevents effect', async () => {
  const f=fixture();await f.commands.openContent(doc);let release!:()=>void,effects=0;const waiting=new Promise<void>(resolve=>{release=resolve;}), identity={};
  const owner:WorkspaceOwner={identity,target:doc,moveEditor:async(_placement,current)=>{await waiting;if(!current())return false;effects++;return true;}};
  f.commands.registerOwner(owner);const first=f.commands.moveEditor(doc,'right');f.commands.registerOwner({...owner});release();
  assert.equal(await first,true);assert.equal(effects,1);
  let release2!:()=>void;const waiting2=new Promise<void>(resolve=>{release2=resolve;});const old={identity:{},target:doc,moveEditor:async(_placement:'center'|'right',current:()=>boolean)=>{await waiting2;if(!current())return false;effects++;return true;}};
  f.commands.registerOwner(old);const second=f.commands.moveEditor(doc,'right');f.commands.registerOwner({identity:{},target:doc,moveEditor:async()=>true});f.commands.releaseOwner(old.identity);release2();
  assert.equal(await second,false);assert.equal(effects,1);assert.equal(await f.commands.moveEditor(doc,'right'),true);
});
test('scope loss, changed selection and owner guard failure during await prevent placement effect', async () => {
  for(const reason of ['inactive','scope','navigation','lease','template'] as const){
    const f=fixture();await f.commands.openContent(doc);let done!:()=>void,effects=0,lease=true,templateOpen=false;
    const waiting=new Promise<void>(resolve=>{done=resolve;});
    f.commands.registerOwner({identity:{},target:doc,moveEditor:async(_placement,current)=>{await waiting;if(!current()||!lease||templateOpen)return false;effects++;return true;}});
    const pending=f.commands.moveEditor(doc,'right');
    if(reason==='inactive')f.active(false);if(reason==='scope')f.navigation.scope.epoch='other';if(reason==='navigation')await f.navigation.openDocument(other.id);
    if(reason==='lease')lease=false;if(reason==='template')templateOpen=true;done();assert.equal(await pending,false,reason);assert.equal(effects,0,reason);
  }
});
test('accepted navigator result is not reinterpreted by a later catalog snapshot; attachment never pretends to edit', async () => {
  const f=fixture();await f.commands.openContent(other);f.commands.registerOwner({identity:{},target:other});assert.equal(await f.commands.moveEditor(other,'right'),false);
  let valid=true,current:string|null=null;const navigation={scope:{...scope},getSnapshot:()=>({documentId:current}) as ReturnType<import('../../src/features/reader/navigation/ContentNavigationSession.ts').ContentNavigationSession['getSnapshot']>,openDocument:async(id:string)=>{current=id;valid=false;return {status:'applied' as const};}};
  const command=new WorkspaceCommandSession({navigation,active:()=>true,validateTarget:()=>valid});assert.equal((await command.openContent(doc)).status,'applied');
});

test('observed selection and validity transitions irreversibly invalidate an in-flight move', async () => {
  for (const change of ['selection', 'validity', 'benign'] as const) {
    let current = doc.id, valid = true, release!: () => void, effects = 0;
    const listeners = new Set<() => void>(), notify = () => { for (const listener of listeners) listener(); };
    const navigation = { scope: { ...scope }, getSnapshot: () => ({ documentId: current }) as ReturnType<import('../../src/features/reader/navigation/ContentNavigationSession.ts').ContentNavigationSession['getSnapshot']>,
      openDocument: async (id: string) => { current = id; notify(); return { status: 'applied' as const }; } };
    const command = new WorkspaceCommandSession({ navigation, active: () => true, validateTarget: () => valid,
      observe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
    const wait = new Promise<void>(resolve => { release = resolve; });
    command.registerOwner({ identity: {}, target: doc, moveEditor: async (_placement, ticket) => {
      await wait; if (!ticket()) return false; effects++; return true;
    } });
    const pending = command.moveEditor(doc, 'right');
    if (change === 'selection') { await navigation.openDocument(other.id); await navigation.openDocument(doc.id); }
    if (change === 'validity') { valid = false; notify(); valid = true; notify(); }
    if (change === 'benign') notify();
    release();
    assert.equal(await pending, change === 'benign', change);
    assert.equal(effects, change === 'benign' ? 1 : 0, change);
    assert.equal(listeners.size, 0, 'operation releases its observer');
  }
});

test('a rejected owner operation releases its observer', async () => {
  const listeners = new Set<() => void>();
  const navigation = { scope: { ...scope }, getSnapshot: () => ({ documentId: doc.id }) as ReturnType<import('../../src/features/reader/navigation/ContentNavigationSession.ts').ContentNavigationSession['getSnapshot']>,
    openDocument: async () => ({ status: 'applied' as const }) };
  const command = new WorkspaceCommandSession({ navigation, active: () => true, validateTarget: () => true,
    observe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
  command.registerOwner({ identity: {}, target: doc, moveEditor: async () => { throw new Error('owner failed'); } });
  await assert.rejects(command.moveEditor(doc, 'right'), /owner failed/);
  assert.equal(listeners.size, 0);
});

test('focus changes require every entry owner while exit only requires layout-safe reader', () => {
  const f = fixture(), identities = Array.from({ length: 5 }, () => ({}));
  let catalog = true, reader = true, updates = 0;
  const stop = f.commands.subscribeFocus(() => { updates++; });
  const roles = ['settings', 'catalog', 'annotation-session', 'annotation-panel', 'reader'] as const;
  const cleanups = roles.map((role, index) => f.commands.registerFocusGuard(role, identities[index], () =>
    role === 'catalog' ? catalog : role === 'reader' ? reader : true));
  catalog = false; assert.equal(f.commands.setFocusMode(true), false); assert.equal(f.commands.getFocusSnapshot(), false);
  catalog = true; assert.equal(f.commands.setFocusMode(true), true); assert.equal(f.commands.getFocusSnapshot(), true);
  catalog = false; reader = false; assert.equal(f.commands.setFocusMode(false), false);
  reader = true; assert.equal(f.commands.setFocusMode(false), true); assert.equal(updates, 2);
  cleanups.forEach(cleanup => cleanup()); stop();
  assert.equal(f.commands.setFocusMode(true), false);
});

test('focus guards fail closed on duplicate, exception, replacement and inactive scope', () => {
  const f = fixture(), roles = ['settings', 'catalog', 'annotation-session', 'annotation-panel', 'reader'] as const;
  const releases = roles.map(role => f.commands.registerFocusGuard(role, {}, () => true));
  const duplicate = f.commands.registerFocusGuard('catalog', {}, () => true);
  assert.equal(f.commands.setFocusMode(true), false); duplicate();
  const throwing = f.commands.registerFocusGuard('catalog', {}, () => { throw new Error('guard'); });
  releases[1](); assert.equal(f.commands.setFocusMode(true), false); throwing();
  let replace = () => {};
  const unstable = f.commands.registerFocusGuard('catalog', {}, () => { replace(); return true; });
  replace = () => { unstable(); f.commands.registerFocusGuard('catalog', {}, () => true); };
  assert.equal(f.commands.setFocusMode(true), false);
  f.active(false); assert.equal(f.commands.setFocusMode(true), false);
});

test('focus notification does not invalidate a live placement ticket and old guard cleanup cannot erase its replacement', async () => {
  const f = fixture(); await f.commands.openContent(doc);
  let release!: () => void, effects = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.commands.registerOwner({ identity: {}, target: doc, moveEditor: async (_placement, current) => {
    await waiting; if (!current()) return false; effects++; return true;
  } });
  const roles = ['settings', 'catalog', 'annotation-session', 'annotation-panel', 'reader'] as const;
  roles.forEach(role => f.commands.registerFocusGuard(role, {}, () => true));
  const identity = {}, stale = f.commands.registerFocusGuard('reader', identity, () => false);
  const replacement = f.commands.registerFocusGuard('reader', identity, () => true);
  stale(); // Replacement survives, but the other reader remains a duplicate.
  assert.equal(f.commands.setFocusMode(true), false);
  replacement();
  const pending = f.commands.moveEditor(doc, 'right');
  assert.equal(f.commands.setFocusMode(true), true);
  release(); assert.equal(await pending, true); assert.equal(effects, 1);
});

test('focus guard cannot reenter or publish after scope becomes inactive during admission', () => {
  const f = fixture(); let reentered: boolean | undefined;
  for (const role of ['settings', 'catalog', 'annotation-session', 'annotation-panel', 'reader'] as const)
    f.commands.registerFocusGuard(role, {}, () => {
      if (role === 'catalog') { reentered = f.commands.setFocusMode(true); f.active(false); }
      return true;
    });
  assert.equal(f.commands.setFocusMode(true), false);
  assert.equal(reentered, false); assert.equal(f.commands.getFocusSnapshot(), false);
});

test('focus prepares visible owners once only after all entry guards approve, never on exit', () => {
  const f = fixture(); let allow = false, preparations = 0;
  const roles = ['settings', 'catalog', 'annotation-session', 'annotation-panel', 'reader'] as const;
  roles.forEach(role => f.commands.registerFocusGuard(role, {}, () => role !== 'catalog' || allow,
    role === 'annotation-panel' ? () => { assert.equal(f.commands.getFocusSnapshot(), false); preparations++; } : undefined));
  assert.equal(f.commands.setFocusMode(true), false); assert.equal(preparations, 0);
  allow = true; assert.equal(f.commands.setFocusMode(true), true); assert.equal(preparations, 1);
  assert.equal(f.commands.setFocusMode(false), true); assert.equal(preparations, 1);
});

test('focus preparation cannot publish after owner replacement or scope loss', () => {
  for (const mode of ['owner', 'scope'] as const) {
    const f = fixture(); let release = () => {};
    for (const role of ['settings', 'catalog', 'annotation-session', 'annotation-panel', 'reader'] as const) {
      const cleanup = f.commands.registerFocusGuard(role, {}, () => true, role === 'annotation-panel' ? () => {
        if (mode === 'owner') { release(); f.commands.registerFocusGuard('catalog', {}, () => true); }
        else f.active(false);
      } : undefined);
      if (role === 'catalog') release = cleanup;
    }
    assert.equal(f.commands.setFocusMode(true), false, mode);
    assert.equal(f.commands.getFocusSnapshot(), false, mode);
  }
});

test('replaced focus owner cleanup never removes the new preparation callback', () => {
  const f = fixture(); let old = 0, next = 0;
  for (const role of ['settings', 'catalog', 'annotation-session', 'reader'] as const)
    f.commands.registerFocusGuard(role, {}, () => true);
  const identity = {}, stale = f.commands.registerFocusGuard('annotation-panel', identity, () => true, () => { old++; });
  f.commands.registerFocusGuard('annotation-panel', identity, () => true, () => { next++; });
  stale();
  assert.equal(f.commands.setFocusMode(true), true); assert.equal(old, 0); assert.equal(next, 1);
});


const relatedOtherRoles = (f: ReturnType<typeof fixture>) => { for (const role of ['settings','catalog','annotation-session','annotation-panel'] as const) f.commands.registerFocusGuard(role, {}, () => true); };

test('related panel visibility checks real reader and panel owners and blockers in both directions', () => {
  const f=fixture(); let reader=true, panel=true, blocker=true, changes=0;
  f.commands.subscribeRelatedPanel(()=>{changes++;});
  assert.equal(f.commands.setRelatedPanelOpen(true),false);
  relatedOtherRoles(f); f.commands.registerFocusGuard('reader',{},()=>reader);
  f.commands.registerRelatedPanelGuard({},()=>panel);
  f.commands.registerFocusBlocker({},()=>blocker);
  for (const block of ['reader','panel','blocker'] as const) {
    if(block==='reader')reader=false;if(block==='panel')panel=false;if(block==='blocker')blocker=false;
    assert.equal(f.commands.setRelatedPanelOpen(true),false,block);reader=panel=blocker=true;
  }
  assert.equal(f.commands.setRelatedPanelOpen(true),true);assert.equal(changes,1);
  assert.equal(f.commands.setRelatedPanelOpen(true),true);assert.equal(changes,1);
  reader=false;assert.equal(f.commands.setRelatedPanelOpen(false),false);reader=true;
  panel=false;assert.equal(f.commands.setRelatedPanelOpen(false),false);panel=true;
  blocker=false;assert.equal(f.commands.setRelatedPanelOpen(false),false);blocker=true;
  assert.equal(f.commands.setRelatedPanelOpen(false),true);assert.equal(changes,2);
});

test('related panel rejects owner replacement, exceptions, scope loss and reentry', () => {
  for (const mode of ['reader','panel','scope','throw','reenter'] as const) {
    const f=fixture();let calls=0, release=()=>{};relatedOtherRoles(f);
    f.commands.registerRelatedPanelGuard({},()=>true);
    release=f.commands.registerFocusGuard('reader',{},()=>{
      calls++; if(calls===1){if(mode==='reader'){release();f.commands.registerFocusGuard('reader',{},()=>true);}
        if(mode==='panel')f.commands.registerRelatedPanelGuard({},()=>true);
        if(mode==='scope')f.active(false);if(mode==='throw')throw new Error('guard');
        if(mode==='reenter')assert.equal(f.commands.setRelatedPanelOpen(true),false);}
      return true;
    });
    if(mode==='reenter')assert.equal(f.commands.setRelatedPanelOpen(true),true);
    else assert.equal(f.commands.setRelatedPanelOpen(true),false,mode);
  }
});


test('related visibility refuses missing or duplicate role and respects identity-checked panel cleanup', () => {
  for (const missing of ['settings','catalog','annotation-session','annotation-panel','reader'] as const) {
    const f=fixture(); f.commands.registerRelatedPanelGuard({},()=>true);
    for (const role of ['settings','catalog','annotation-session','annotation-panel','reader'] as const)
      if(role!==missing) f.commands.registerFocusGuard(role,{},()=>true);
    assert.equal(f.commands.setRelatedPanelOpen(true),false,missing);
  }
  for (const duplicate of ['settings','catalog','annotation-session','annotation-panel','reader'] as const) {
    const f=fixture(); f.commands.registerRelatedPanelGuard({},()=>true);
    for (const role of ['settings','catalog','annotation-session','annotation-panel','reader'] as const)
      f.commands.registerFocusGuard(role,{},()=>true);
    f.commands.registerFocusGuard(duplicate,{},()=>true);
    assert.equal(f.commands.setRelatedPanelOpen(true),false,duplicate);
  }
  const f=fixture();relatedOtherRoles(f);f.commands.registerFocusGuard('reader',{},()=>true);
  const identity={},old=f.commands.registerRelatedPanelGuard(identity,()=>false);
  f.commands.registerRelatedPanelGuard(identity,()=>true);old();
  assert.equal(f.commands.setRelatedPanelOpen(true),true);
});
