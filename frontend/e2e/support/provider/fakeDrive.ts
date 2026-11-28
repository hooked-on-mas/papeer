import type { BrowserContext } from 'playwright-core';

export type FixtureTimingSpan = { sequence:number; started:number; finished?:number; category:string; method:string; status?:number; outcome?:string; phase?:'body-read'|'body-ready'|'binding-pending'|'decode'|'settled'; mutations?:Record<string,number> };
export type FixtureTimingSnapshot = { sequence:number; entries:FixtureTimingSpan[] };

export type DriveFixtureRequest = { url: string; method: string; headers: Record<string,string>; bodyBase64: string };
export type DriveFixtureResponse = { status: number; headers: Record<string,string>; bodyBase64: string };
export type IncomingEditListMode = 'normal' | 'empty-success' | '503';
type IncomingEditListBinding = { namespace: string; parentId: string };

type Input=DriveFixtureRequest;type Output=DriveFixtureResponse;
type DriveFile = { id:string; name:string; mimeType:string; version:string; size:string; ownedByMe:boolean; trashed:false;
  parents?:string[]; capabilities:{canEdit:true;canDownload:true}; properties?:Record<string,string>; body:string; bytes:Buffer };

/** Synthetic HTTP boundary only: no provider authority, user data, or token persistence. */
export function createCompositionDrive(options: {uncertainDescriptor?:boolean} = {}) {
  const files=new Map<string,DriveFile>(),posts:string[]=[],calls:Record<string,number>={}, sessions=new Map<string,{metadata:Partial<DriveFile>;chunks:Buffer[];length:number;total:number;mediaType:string;completedId?:string}>();
  const incomingEditLists=new Map<string,{mode:Exclude<IncomingEditListMode,'normal'>;binding:IncomingEditListBinding}>();
  let counter=1,uncertain=!!options.uncertainDescriptor,hold:{client:string;entered():void;gate:Promise<void>}|undefined;
  const reply=(status:number,value:unknown,headers:Record<string,string>={}):Output=>({status,headers,bodyBase64:Buffer.from(JSON.stringify(value)).toString('base64')});
  const store=(metadata:Partial<DriveFile>,bytes:Buffer):Output=>{
    const id=metadata.id??'ordinaryObject'+counter++;posts.push(id);
    if(files.has(id))return reply(409,{error:{code:409}});
    files.set(id,{...metadata,id,name:metadata.name!,mimeType:metadata.mimeType!,version:'1',size:String(bytes.length),ownedByMe:true,trashed:false,capabilities:{canEdit:true,canDownload:true},body:bytes.toString('utf8'),bytes});
    if(metadata.properties?.providerKind==='descriptor'&&uncertain){uncertain=false;return reply(200,{id:'unconfirmed-receipt'});}
    return reply(200,{id});
  };
  return {files,posts,calls,
    setIncomingEditListMode(client:'native'|'web',mode:IncomingEditListMode,binding?:IncomingEditListBinding){
      if(client!=='native'&&client!=='web')throw new Error('fixture-canonical-client-required');
      if(mode==='normal'){incomingEditLists.delete(client);return;}
      if(!['empty-success','503'].includes(mode)||!binding||!/^[0-9a-f]{64}$/.test(binding.namespace)||!/^[\w-]+$/.test(binding.parentId))throw new Error('fixture-canonical-list-binding-required');
      incomingEditLists.set(client,{mode,binding:{...binding}});
    },
    holdPull(client:string){let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});hold={client,entered,gate};return {reached,release};},
    async request(input:Input,client:string):Promise<Output>{
      const url=new URL(input.url);if(url.protocol!=='https:'||url.hostname!=='www.googleapis.com')throw new Error('fixture-google-origin-required');
      const method=input.method.toUpperCase(),headers=Object.fromEntries(Object.entries(input.headers).map(([k,v])=>[k.toLowerCase(),v]));
      if(!headers.authorization?.startsWith('Bearer '))return reply(401,{error:{code:401}});
      const bytes=Buffer.from(input.bodyBase64,'base64'),id=decodeURIComponent(url.pathname.split('/').pop()!);
      const callKey=client+':'+method+':'+(url.pathname.endsWith('/files')?'files-list-or-post':url.pathname.endsWith('/about')?'about':url.searchParams.get('alt')==='media'?'media':'metadata');calls[callKey]=(calls[callKey]??0)+1;
      if(url.pathname==='/drive/v3/about'&&method==='GET')return reply(200,{user:{permissionId:'fixture-only-google-permission-id'}});
      if(url.pathname==='/drive/v3/files/generateIds'&&method==='GET'){
        const value=url.searchParams.get('count')??'';if(!/^[1-9]\d*$/.test(value)||Number(value)>100)throw new Error('fixture-generate-ids-count');
        return reply(200,{ids:Array.from({length:Number(value)},()=> 'googleGenerated'+counter++)});
      }
      if(method==='POST'&&(url.pathname==='/drive/v3/files'||url.pathname==='/upload/drive/v3/files')){
        const type=headers['content-type']??'';
        // Google resumable upload: https://developers.google.com/workspace/drive/api/guides/manage-uploads
        if(url.searchParams.get('uploadType')==='resumable'){
          const metadata=JSON.parse(bytes.toString('utf8')) as Partial<DriveFile>,session='fixtureSession'+counter++;
          const declared=headers['x-upload-content-length']??'',mediaType=headers['x-upload-content-type']??'';
          if(!/^[1-9]\d*$/.test(declared)||Number(declared)>128*1024*1024||!mediaType)throw new Error('fixture-upload-declaration');
          if(metadata.id&&files.has(metadata.id))return reply(409,{error:{code:409}});
          sessions.set(session,{metadata,chunks:[],length:0,total:Number(declared),mediaType});return reply(200,{}, {location:'https://www.googleapis.com/upload/drive/v3/files?upload_id='+session});
        }
        if(url.pathname==='/upload/drive/v3/files'&&url.searchParams.get('uploadType')!=='multipart')throw new Error('fixture-upload-type');
        if(url.pathname==='/drive/v3/files'&&url.searchParams.has('uploadType'))throw new Error('fixture-upload-path');
        let metadata:Partial<DriveFile>,payload=Buffer.alloc(0);
        if(type.startsWith('multipart/related')){
          const boundary=type.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);if(!boundary)throw new Error('fixture-multipart-boundary');
          const marker=Buffer.from('--'+(boundary[1]??boundary[2])),delimiter=Buffer.concat([Buffer.from('\r\n'),marker]),first=bytes.indexOf(marker),secondLine=bytes.indexOf(delimiter,first+marker.length),lastLine=bytes.indexOf(delimiter,secondLine+delimiter.length),second=secondLine+2,last=lastLine+2;
          const part=(a:number,b:number)=>{const split=bytes.indexOf(Buffer.from('\r\n\r\n'),a);if(split<0||split>=b)throw new Error('fixture-multipart-format');return bytes.subarray(split+4,b-2);};
          if(first!==0||secondLine<0||lastLine<0||bytes.subarray(last+marker.length).toString('ascii').replace(/\r\n$/,'')!=='--')throw new Error('fixture-multipart-format');metadata=JSON.parse(part(first,second).toString('utf8'));payload=Buffer.from(part(second,last));
        }else metadata=JSON.parse(bytes.toString('utf8'));
        return store(metadata,payload);
      }
      if(method==='PUT'&&url.pathname==='/upload/drive/v3/files'&&url.searchParams.has('upload_id')){
        const session=sessions.get(url.searchParams.get('upload_id')!);if(!session)return reply(404,{error:{code:404}});
        const probe=/^bytes \*\/(\d+)$/.exec(headers['content-range']??'');
        if(probe){if(Number(probe[1])!==session.total||bytes.length)throw new Error('fixture-content-range');if(session.completedId)return reply(200,{id:session.completedId});return reply(308,{},session.length?{range:`bytes=0-${session.length-1}`} : {});}
        const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range']??'');if(!range)throw new Error('fixture-content-range');
        const start=Number(range[1]),end=Number(range[2]),total=Number(range[3]);if(session.completedId||total!==session.total||headers['content-type']!==session.mediaType||start!==session.length||end-start+1!==bytes.length||end>=total||(end+1<total&&bytes.length%(256*1024)!==0))throw new Error('fixture-content-range');
        session.chunks.push(bytes);session.length+=bytes.length;if(session.length<total)return reply(308,{}, {range:`bytes=0-${session.length-1}`});
        const result=store(session.metadata,Buffer.concat(session.chunks));if(result.status===200)session.completedId=(JSON.parse(Buffer.from(result.bodyBase64,'base64').toString('utf8')) as {id:string}).id;return result;
      }
      if(method==='GET'&&url.pathname==='/drive/v3/files'){
        // Supported fixture query subset: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
        const query=url.searchParams.get('q')??'',predicates:((file:DriveFile)=>boolean)[]=[];let rest=query.trim();
        const properties:[string,string][]=[],parents:string[]=[],trash:string[]=[];let otherPredicate=false;
        while(rest){const match=/^(?:properties\s+has\s*\{\s*key='([^']+)'\s+and\s+value='([^']+)'\s*\}|trashed\s*=\s*(false|true)|'([^']+)'\s+in\s+(parents|owners)|mimeType\s*=\s*'([^']+)')(?:\s+and\s+|\s*$)/.exec(rest);if(!match)throw new Error('fixture-unsupported-query');
          if(match[1]){properties.push([match[1],match[2]]);predicates.push(file=>file.properties?.[match[1]]===match[2]);}
          else if(match[3]){trash.push(match[3]);predicates.push(file=>file.trashed===(match[3]==='true'));}
          else if(match[5]==='parents'){parents.push(match[4]);predicates.push(file=>!!file.parents?.includes(match[4]));}
          else if(match[5]==='owners'){otherPredicate=true;if(match[4]!=='me')throw new Error('fixture-unsupported-owner');predicates.push(file=>file.ownedByMe);}
          else{otherPredicate=true;predicates.push(file=>file.mimeType===match[6]);}rest=rest.slice(match[0].length);
        }
        // Exact canonical log list only. Native pull() and files() use the same q;
        // this fixture fault covers both, not a claim of inbound-only isolation.
        const fault=incomingEditLists.get(client);
        const canonicalList=fault&&url.searchParams.getAll('q').length===1&&!url.searchParams.has('uploadType')&&!url.searchParams.has('alt')&&!otherPredicate&&properties.length===2
          &&properties.filter(([key,value])=>key==='papeer'&&value==='edits-v1').length===1
          &&properties.filter(([key,value])=>key==='scope'&&value===fault.binding.namespace).length===1
          &&trash.length===1&&trash[0]==='false'&&parents.length<=1
          &&(parents.length===0||parents[0]===fault.binding.parentId);
        if(fault&&canonicalList)return fault.mode==='empty-success'?reply(200,{files:[]}):reply(503,{error:{code:503,message:'fixture canonical edit list unavailable'}});
        const result=reply(200,{files:[...files.values()].filter(file=>predicates.every(test=>test(file))).map(({body:_body,bytes:_bytes,...metadata})=>metadata)});
        if(hold?.client===client&&query.includes('edits-v1')){const pending=hold;hold=undefined;pending.entered();await pending.gate;}return result;
      }
      if(method!=='GET')return reply(405,{error:{code:405}});
      if(!/^\/drive\/v3\/files\/[^/]+$/.test(url.pathname))throw new Error('fixture-unsupported-route');
      const file=files.get(id);if(!file)return reply(404,{error:{code:404}});
      if(url.searchParams.get('alt')==='media')return {status:200,headers:{'content-type':file.mimeType},bodyBase64:file.bytes.toString('base64')};
      const {body:_body,bytes:_bytes,...metadata}=file;return reply(200,metadata);
    }};
}

export async function installBrowserDriveBoundary(context:BrowserContext,drive:ReturnType<typeof createCompositionDrive>,client:string){
 await context.exposeBinding('__fixtureDrive',(_source,input:Input)=>drive.request(input,client));
 await context.addInitScript(()=>{
  const current=window as unknown as {__fixtureDrive(input:Input):Promise<Output>;fixtureGesture?:boolean;google:unknown;fixtureDriveTimings():FixtureTimingSnapshot};
  const timingEnabled=new URLSearchParams(location.search).get('startupDiagnostics')==='1';
  let sequence=0;const timings:FixtureTimingSpan[]=[];
  current.fixtureDriveTimings=()=>({sequence,entries:timings.map(value=>({...value}))});
  current.google={accounts:{oauth2:{initTokenClient:(options:{callback(value:unknown):void})=>({requestAccessToken(){current.fixtureGesture=navigator.userActivation.isActive;queueMicrotask(()=>options.callback({access_token:'fixture-only-token',expires_in:3600}));}})}}};
  const real=window.fetch.bind(window);
  window.fetch=async(input,init={})=>{
   const normalized=new Request(input,init),url=normalized.url;if(!url.startsWith('https://www.googleapis.com/'))return real(normalized);
   const parsed=new URL(url),method=normalized.method;
   const category=parsed.pathname.endsWith('/files')?'files-list-or-post':parsed.pathname.endsWith('/about')?'about':parsed.searchParams.get('alt')==='media'?'media':'metadata';
   const span:FixtureTimingSpan|undefined=timingEnabled?{sequence:++sequence,started:performance.now(),category,method:['GET','POST','PUT'].includes(method)?method:'other'}:undefined;
   if(span){timings.push(span);if(timings.length>256)timings.shift();}
   try{
   if(normalized.signal.aborted)throw new DOMException('Cancelled','AbortError');
   if(span)span.phase='body-read';
   // Request construction already rejects a body for GET/HEAD; do not await an empty cloned stream.
   const raw=method==='GET'||method==='HEAD'?new Uint8Array():new Uint8Array(await normalized.clone().arrayBuffer());if(span)span.phase='body-ready';let binary='';for(let i=0;i<raw.length;i+=0x8000)binary+=String.fromCharCode(...raw.subarray(i,i+0x8000));
   if(normalized.signal.aborted)throw new DOMException('Cancelled','AbortError');
   if(span)span.phase='binding-pending';
   const headers=Object.fromEntries(normalized.headers.entries()),request=current.__fixtureDrive({url,method:normalized.method,headers,bodyBase64:btoa(binary)});
   let cancel=()=>{};const aborted=new Promise<never>((_resolve,reject)=>{cancel=()=>reject(new DOMException('Cancelled','AbortError'));normalized.signal.addEventListener('abort',cancel,{once:true});});
   const answer=await Promise.race([request,aborted]).finally(()=>normalized.signal.removeEventListener('abort',cancel));if(normalized.signal.aborted)throw new DOMException('Cancelled','AbortError');
   if(span)span.phase='decode';
   const decoded=atob(answer.bodyBase64),body=Uint8Array.from(decoded,c=>c.charCodeAt(0));if(span){span.status=answer.status;span.outcome='response';}return new Response(body,{status:answer.status,headers:answer.headers});
   }catch(error){if(span)span.outcome=error instanceof DOMException&&error.name==='AbortError'?'aborted':'error';throw error;}
   finally{if(span){span.phase='settled';span.finished=performance.now();}}
  };
 });
}
