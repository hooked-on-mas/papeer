import { BootstrapSession } from '../../features/bootstrap/BootstrapSession.ts';
import { createDesktopBootstrapHostDriver } from './bootstrapHostDriver.ts';
import { createDesktopCloseController, tauriCloseHost, type DesktopCloseHost } from './desktopWindowClose.ts';

/**
 * The one production factory of the PC normal entry. It builds, in order: the native host driver
 * (real loopback URL and bearer, no injected grant/lease/proof), the single BootstrapSession that
 * owns the driver for the window lifetime, and the window-close controller. Only `fetcher` and
 * `closeHost` are replaceable, and only for tests; neither can carry an authority.
 */
export function createDesktopBootstrapHost({ fetcher, closeHost }: {
  fetcher?: typeof fetch; closeHost?: DesktopCloseHost;
} = {}) {
  const host = createDesktopBootstrapHostDriver(fetcher);
  const session = new BootstrapSession(host);
  const close = createDesktopCloseController(session, closeHost ?? tauriCloseHost(fetcher));
  return { session, close };
}
export type DesktopBootstrapHost = ReturnType<typeof createDesktopBootstrapHost>;
