import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceSelectionSession, decodeWorkspaceSelection } from '../../src/features/workspace/WorkspaceSelectionSession.ts';
import { BrowserWorkspaceSelection } from '../../src/adapters/browser/workspaceSelection.ts';
const scope={accountId:'a',libraryId:'b',epoch:'c'}, id='12345678-1234-1234-1234-123456789abc';
test('selection read is scope-local and never writes on absent or invalid cache',()=>{
  const map=new Map<string,string>();const store={getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);}};
  const port=new BrowserWorkspaceSelection(scope,store), other=new BrowserWorkspaceSelection({...scope,epoch:'other'},store);
  const s=new WorkspaceSelectionSession(port,()=>true);assert.equal(s.candidate(),null);assert.equal(map.size,0);
  assert.equal(s.select({documentId:id}),true);assert.equal(new WorkspaceSelectionSession(other,()=>true).candidate(),null);
  assert.equal(new WorkspaceSelectionSession(port,()=>true).candidate()?.value.documentId,id);
  assert.throws(()=>decodeWorkspaceSelection({version:1,documentId:[id],folderId:null}));
  const bad=new WorkspaceSelectionSession({scope,read:()=>({version:1,documentId:id,folderId:null,extra:1}),write:()=>{throw new Error('must not write');}},()=>true);
  assert.ok(bad.readError);assert.equal(bad.candidate(),null);
});
test('explicit interaction invalidates late restoration and stale scope refuses writes; write failures do not throw',()=>{
  let active=true, writes=0, fail=false;const port={scope,read:()=>({version:1,documentId:id,folderId:null}),write:()=>{writes++;if(fail)throw new Error('quota');}};
  const s=new WorkspaceSelectionSession(port,()=>active), ticket=s.candidate()!;s.invalidate();assert.equal(s.isCurrent(ticket.generation),false);
  fail=true;assert.equal(s.select({folderId:id}),false);assert.equal(writes,1);active=false;assert.equal(s.select({documentId:null}),false);assert.equal(writes,1);
});

test('same lifecycle ticket remains distinguishable while scope is inactive, but interaction invalidates it',()=>{
  let active=true;const port={scope,read:()=>({version:1,documentId:id,folderId:null}),write:()=>{}};
  const s=new WorkspaceSelectionSession(port,()=>active), ticket=s.candidate()!;active=false;
  assert.equal(s.sameTicket(ticket.generation),true);assert.equal(s.isCurrent(ticket.generation),false);
  active=true;assert.equal(s.isCurrent(ticket.generation),true);s.invalidate();assert.equal(s.sameTicket(ticket.generation),false);
});
