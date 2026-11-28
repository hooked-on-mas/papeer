// Browser-only contract fixture: real LocalHostAuthority and isolated IndexedDB, fake provider verifier.
import { LocalHostAuthority } from '../../../src/adapters/browser/localHostAuthority.ts';
import { ProviderGrantIssuer } from '../../../src/adapters/browser/ownership/providerGrantIssuer.ts';
import type { HostLease } from '../../../src/features/bootstrap/bootstrapPorts.ts';

export async function exerciseProviderGrantAuthority(): Promise<void> {
  const name = `provider-issuer-${crypto.randomUUID()}`, authority = new LocalHostAuthority(indexedDB, name);
  const controller = new AbortController(), signal = controller.signal;
  try {
    const lease = await authority.provision(signal);
    const scope = { accountId: crypto.randomUUID(), libraryId: crypto.randomUUID(), epoch: crypto.randomUUID() };
    let generation = 1, release: (() => void) | undefined, block = false;
    const issuer = new ProviderGrantIssuer(authority, {
      async current() { return { digest: 'a'.repeat(64), generation }; },
      async descriptor(_principal, selection) {
        if (block) await new Promise<void>(resolve => { release = resolve; });
        return { id: selection, version: '1', sha256: 'b'.repeat(64), scope, owner: true, writable: true };
      },
    });
    let refused = false;
    try { await issuer.connect({} as HostLease, signal); } catch { refused = true; }
    if (!refused) throw new Error('forged lease accepted');
    const grant = await issuer.connect(lease, signal), handle = await issuer.select(grant, 'remote-object', signal);
    await issuer.resolve(grant, handle, scope, signal);
    block = true;
    const pending = issuer.select(grant, 'pending-object', signal);
    for (let attempt = 0; !release && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    if (!release) throw new Error('descriptor verifier did not enter');
    authority.invalidate(); generation++; release();
    refused = false; try { await pending; } catch { refused = true; }
    if (!refused) throw new Error('pending descriptor survived real authority invalidation');
    refused = false; try { await issuer.resolve(grant, handle, scope, signal); } catch { refused = true; }
    if (!refused) throw new Error('invalidated lease accepted');
  } finally {
    authority.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('fixture-delete-failed'));
      request.onblocked = () => reject(new Error('fixture-delete-blocked'));
    });
  }
}

(window as unknown as { exerciseProviderGrantAuthority: typeof exerciseProviderGrantAuthority }).exerciseProviderGrantAuthority = exerciseProviderGrantAuthority;
