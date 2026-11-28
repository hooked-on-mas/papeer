import { validateCanonicalLibraryInitializationIntent, validateCanonicalInitializeRequest, type CanonicalInitializeRequest, type CanonicalLibraryInitializationIntent } from './contracts.ts';
import { editContentHash } from './editContentHash.ts';
import { canonicalJson, EditRejected } from './editModel.ts';
export async function makeInitializationIntent(input: CanonicalInitializeRequest, accountId: string): Promise<CanonicalLibraryInitializationIntent> {
  const request=structuredClone(input); validateCanonicalInitializeRequest(request);
  if (request.profile.identity.accountId !== accountId || canonicalJson(request.control.identity) !== canonicalJson(request.profile.identity)) throw new EditRejected('dataset-scope');
  return {version:1,accountId,requestId:request.control.id,requestSha256:await editContentHash(request),request,result:null};
}
export async function assertInitializationIntent(input: unknown): Promise<CanonicalLibraryInitializationIntent> {
  const value = structuredClone(input);
  validateCanonicalLibraryInitializationIntent(value);
  if ('retired' in value) { if (value.identity.accountId !== value.accountId) throw new EditRejected('dataset-scope'); return value; }
  const expected=await makeInitializationIntent(value.request,value.accountId);
  if (value.requestId !== expected.requestId || value.requestSha256 !== expected.requestSha256) throw new EditRejected('initialization-intent-mismatch');
  if (value.result?.status === 'accepted') {
    const manifest=value.request.control.transition.publication.manifest;
    const receipt={requestId:value.requestId,identity:value.request.profile.identity,initialScope:manifest.scope,manifestId:manifest.id,peerId:value.request.expectedPeerId};
    if (canonicalJson(receipt) !== canonicalJson(value.result.receipt)) throw new EditRejected('initialization-intent-mismatch');
  }
  return value;
}

