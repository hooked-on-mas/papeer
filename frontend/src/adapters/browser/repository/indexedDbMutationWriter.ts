import type { EditScope } from '../../../runtime/edits/ports.ts';
import type { EditMutation } from '../../../runtime/edits/repositoryPlan.ts';

type Row = { key: string; scope: string; value: unknown };
const key = (...parts: string[]) => JSON.stringify(parts);

export function sameStoredValue(a: unknown, b: unknown): boolean {
 if (a instanceof Uint8Array || b instanceof Uint8Array) return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((v,i) => v === b[i]);
 if (a === undefined || b === undefined) return a === b;
 if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v,i) => sameStoredValue(v,b[i]));
 if (a && b && typeof a === 'object' && typeof b === 'object') { const ak=Object.keys(a).sort(), bk=Object.keys(b).sort(); return sameStoredValue(ak,bk) && ak.every(k => sameStoredValue((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k])); }
 return a === b;
}

/** The single native enqueue implementation for repository plans and owner activation. */
export function enqueueEditMutations(tx: IDBTransaction, scope: EditScope, mutations: readonly EditMutation[], finish: () => void): void {
  const ns=key(scope.accountId,scope.libraryId,scope.epoch),pageChecks:{key:string;value:unknown}[]=[],prunes=mutations.filter((m):m is Extract<EditMutation,{kind:'prune-projections'}>=>m.kind==='prune-projections');
  for(const m of mutations)if(m.kind==='put-projection'&&m.snapshot.kind==='document') for(const page of [...m.snapshot.pages,...m.snapshot.deletedPages,...(m.snapshot.translation?.pages??[])]){
   const id=[m.snapshot.id,page.id,page.backgroundRevision,page.lifecycleVersion,page.annotationVersion].join(':');pageChecks.push({key:key(ns,id),value:page}); }
  const uniquePages=new Map<string,unknown>(); for(const page of pageChecks){if(uniquePages.has(page.key)&&!sameStoredValue(uniquePages.get(page.key),page.value)){tx.abort();return;} uniquePages.set(page.key,page.value);}
  const requests=pageChecks.map(page=>tx.objectStore('pages').get(page.key));
  const projections=prunes.length?tx.objectStore('projections').index('scope').getAll(ns):null, pages=prunes.length?tx.objectStore('pages').index('scope').getAllKeys(ns):null;
  let pending=requests.length+(projections?1:0)+(pages?1:0); const apply=()=>{
   for(let i=0;i<requests.length;i++){const existing=requests[i].result as Row|undefined;if(existing && (existing.scope!==ns||!sameStoredValue(existing.value,pageChecks[i].value))){tx.abort();return;}}
   const put=(store:string,id:string,value:unknown)=>tx.objectStore(store).put({key:key(ns,id),scope:ns,value});
   for(const m of mutations)switch(m.kind){
    case 'put-root':put('roots',m.root.id,m.root);break;case 'put-edit':put('edits',m.edit.batch.id,m.edit);break;
    case 'put-intent':if(m.record)put('intents',m.targetId,m.record);else tx.objectStore('intents').delete(key(ns,m.targetId));break;
    case 'put-dataset':put('datasets',m.manifest.id,m.manifest);break;case 'put-resource':put('resources',m.resource.metadata.id,m.resource.metadata);put('resourceBytes',m.resource.metadata.sha256,m.resource.bytes);break;
    case 'remember-checkpoint':put('checkpoints',m.sha256,true);break;
    case 'put-projection': { const snap=m.snapshot;if(snap.kind!=='document'){put('projections',`${snap.id}:${snap.version}`,snap);break;}
     const project=(page:typeof snap.pages[number])=>{const id=[snap.id,page.id,page.backgroundRevision,page.lifecycleVersion,page.annotationVersion].join(':');put('pages',id,page);return id;};
     put('projections',`${snap.id}:${snap.version}`,{...snap,pages:snap.pages.map(project),deletedPages:snap.deletedPages.map(project),...(snap.translation?{translation:{...snap.translation,pages:snap.translation.pages.map(project)}}:{})});break; }
    case 'prune-projections':case 'put-control':break;
   }
   // Prune against old and newly enqueued projections, respecting the plan's final keep set.
   for(const prune of prunes){const retained=new Set<string>(); const all=[...((projections?.result??[]) as Row[]).map(row=>row.value),...mutations.filter((m):m is Extract<EditMutation,{kind:'put-projection'}>=>m.kind==='put-projection').map(m=>m.snapshot)];
    for(const value of all){const v=value as {id:string;version:string;pages?:unknown[];deletedPages?:unknown[];translation?:{pages:unknown[]}};if(v.id!==prune.targetId)continue;if(!prune.versions.includes(v.version)){tx.objectStore('projections').delete(key(ns,`${v.id}:${v.version}`));continue;}
     for(const page of [...(v.pages??[]),...(v.deletedPages??[]),...(v.translation?.pages??[])]){if(typeof page==='string')retained.add(page);else {const p=page as {id:string;backgroundRevision:string;lifecycleVersion:string;annotationVersion:string};retained.add([v.id,p.id,p.backgroundRevision,p.lifecycleVersion,p.annotationVersion].join(':'));}} }
    const pageKeys=new Set<IDBValidKey>([...(pages?.result??[]),...pageChecks.map(page=>page.key)]);
    for(const k of pageKeys){const [,id]=JSON.parse(String(k)) as [string,string];if(id.startsWith(`${prune.targetId}:`)&&!retained.has(id))tx.objectStore('pages').delete(k);}
   }
   finish();
  };
  if(!pending){apply();return;} const ready=()=>{try{if(!--pending)apply();}catch{try{tx.abort();}catch{/* finished */}}}; requests.forEach(r=>{r.onsuccess=ready;});if(projections)projections.onsuccess=ready;if(pages)pages.onsuccess=ready;
}
