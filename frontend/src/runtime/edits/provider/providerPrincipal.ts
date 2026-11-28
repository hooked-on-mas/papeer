import { canonicalJson } from '../editModel.ts';
import { resourceHash } from '../contentPublication.ts';
/** Provider principal is not a canonical namespace UUID. No token/email/client-id enters this digest. */
export async function googleDrivePrincipalDigest(permissionId: string): Promise<string> {
 if (typeof permissionId !== 'string' || !permissionId || Array.from(permissionId).length > 200 || /[\u0000-\u0020\u007f]/.test(permissionId)
  || Array.from(permissionId).some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) throw new Error('drive-principal-invalid');
 return resourceHash(new TextEncoder().encode(canonicalJson(['papeer.provider.principal.v1', 'google-drive', 'drive.permissionId', permissionId])));
}
