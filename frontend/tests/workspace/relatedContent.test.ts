import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LibraryItem, LibrarySnapshot } from '../../src/runtime/edits/contracts.ts';
import { projectRelatedContent } from '../../src/features/workspace/related/relatedContent.ts';
const item = (id: string, kind: LibraryItem['kind'], ownerId: string | null = null): LibraryItem => ({ id, kind, title: id, ownerId, folderId: null, position: 0, tags: [], read: false, metadata: {} });
const make = (): LibrarySnapshot => ({ kind:'library', id:'library', version:'version', folders:[], links:[], deletions:[], items:[item('owner','pdf'),item('note','markdown','owner'),item('ink','notebook','owner'),item('file','attachment','owner'),item('other','markdown')] });
test('related projection uses exact live owner and child identities for owner or child selection', () => {
 const catalog=make();const owner=projectRelatedContent(catalog,'owner');assert.equal(owner.status,'ready');
 if(owner.status==='ready')assert.deepEqual(owner.items.map(x=>[x.id,x.kind]),[['note','markdown'],['ink','notebook'],['file','attachment']]);
 assert.deepEqual(projectRelatedContent(catalog,'note'),owner);assert.deepEqual(projectRelatedContent(catalog,'missing'),{status:'unavailable'});
});
test('deleted targets, duplicate identities and deleted owner never become panel targets', () => {
 const catalog=make();catalog.deletions=[{id:'deletion',active:true,itemIds:['file'],observedVersions:{},timestamp:1} as unknown as LibrarySnapshot['deletions'][number]];
 const ready=projectRelatedContent(catalog,'owner');assert.equal(ready.status,'ready');if(ready.status==='ready')assert.deepEqual(ready.items.map(x=>x.id),['note','ink']);
 catalog.items.push(item('note','markdown','owner'));assert.deepEqual(projectRelatedContent(catalog,'note'),{status:'unavailable'});assert.deepEqual(projectRelatedContent(catalog,'owner'),{status:'unavailable'});
 catalog.items.pop();catalog.deletions[0].itemIds.push('owner');assert.deepEqual(projectRelatedContent(catalog,'note'),{status:'unavailable'});
});
