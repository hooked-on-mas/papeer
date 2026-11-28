import { createDesktopBootstrapHostDriver } from '../../src/adapters/desktop/bootstrapHostDriver.ts';
import type { LibraryHandle } from '../../src/features/bootstrap/bootstrapPorts.ts';

async function cases() {
  (window as unknown as { __PAPEER_TOKEN: string }).__PAPEER_TOKEN = 'fixture-real-header';
  const scope = { accountId:'fixture-namespace', libraryId:'00000000-0000-0000-0000-000000000002', epoch:'epoch' };
  let leases = 0, holdPending = false, enter!: () => void; let entered = new Promise<void>(resolve => { enter = resolve; });
  const observed: string[] = [];
  const fake: typeof fetch = async (input,init) => {
    const path = new URL(String(input)).pathname, headers = new Headers(init?.headers), lease = headers.get('X-Papeer-Host-Lease') ?? '';
    if (headers.get('Authorization') !== 'Bearer fixture-real-header') throw new Error('missing bearer');
    const response = (value: unknown) => new Response(JSON.stringify(value),{ status:200, headers:{ 'Content-Type':'application/json' } });
    if (path.endsWith('/local-context/read')) return response({ status:'ready', leaseId:`lease-${++leases}` });
    if (path.endsWith('/discover')) return response({ libraries:[{ handleId:'handle', title:'Library', status:'available' }], creations:[], canCreateLibrary:true });
    if (path.endsWith('/inspect')) return response({ admissionId:`admission-${lease}`, scope, peerId:'00000000-0000-0000-0000-000000000003', fingerprint:'a'.repeat(64) });
    if (path.endsWith('/revalidate')) return response({ scope, peerId:'00000000-0000-0000-0000-000000000003', fingerprint:'a'.repeat(64) });
    if (path.endsWith('/release')) return response({ status:'released' });
    if (path.endsWith('/pending')) {
      observed.push(`${lease}/${headers.get('X-Papeer-Admission')}`);
      if (holdPending) { enter(); return await new Promise<Response>((_resolve,reject) => init?.signal?.addEventListener('abort',() => reject(new DOMException('aborted','AbortError')),{ once:true })); }
      return response([]);
    }
    throw new Error('unexpected request ' + path);
  };
  const driver = createDesktopBootstrapHostDriver(fake), signal = new AbortController().signal;
  try {
    const context = await driver.readLocalContext(signal); if (context.status !== 'ready') throw new Error('fixture');
    const discovery = await driver.discover(context.lease,signal), handle = discovery.libraries[0].handle;
    let forged = false; try { await driver.inspect(context.lease,{} as LibraryHandle,signal); } catch { forged = true; }
    const proof = await driver.inspect(context.lease,handle,signal), acquisition = new AbortController();
    const resources = await driver.openScope(proof,acquisition.signal); acquisition.abort();
    const detached = (await resources.repository.pending()).length === 0;
    holdPending = true; const old = resources.repository.pending(); await entered;
    window.dispatchEvent(new Event('pagehide')); let aborted = false; try { await old; } catch { aborted = true; }
    let draftsLocked = false; try { resources.markdownDrafts.targets(); } catch { draftsLocked = true; }
    const again = await driver.readLocalContext(signal); if (again.status !== 'ready') throw new Error('fixture');
    const next = await driver.inspect(again.lease,handle,signal); const same = driver.sameAdmission(proof,next);
    holdPending = false; await resources.reauthorize(next,signal);
    const resumed = (await resources.repository.pending()).length === 0;
    const captured = observed.join(',') === 'lease-1/admission-lease-1,lease-1/admission-lease-1,lease-2/admission-lease-2';
    await resources.close();
    let closed = false; try { await resources.repository.pending(); } catch { closed = true; }
    return { forged, detached, aborted, draftsLocked, same, resumed, captured, closed };
  } finally { await driver.close(); }
}
Object.assign(window,{ nativeDesktopDriverCases:cases });
