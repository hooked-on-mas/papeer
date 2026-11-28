import type { ReactNode } from 'react';
import { WorkspaceRoot } from '../components/WorkspaceChrome';

/** Authentication and data-source lifecycles belong to the composition, not the frame. */
export function WebAppView({ focused, children, contained }: { focused: boolean; children: ReactNode; contained?: boolean }) {
  return <WorkspaceRoot contained={contained} className={`web-app ${focused ? 'reader-focus' : ''}`}>{children}</WorkspaceRoot>;
}
