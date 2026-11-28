import type { EditScope } from '../../runtime/edits/ports.ts';
import type { InitializationOutcome } from '../../runtime/edits/canonicalInitializationStorage.ts';
import type { paths } from '../../api/schema.d.ts';

/**
 * Generated OpenAPI types constrain paths, POST bodies and header names. Successful
 * responses are unknown in that schema, so the driver validates them before use.
 */
export const bootstrapRoutes = {
  hold: '/api/edits/legacy-startup/read',
  legacyPresence: '/api/edits/legacy-startup/presence',
  readContext: '/api/edits/bootstrap/local-context/read',
  provisionContext: '/api/edits/bootstrap/local-context/provision',
  discover: '/api/edits/bootstrap/discover',
  peer: '/api/edits/bootstrap/peer',
  prepare: '/api/edits/bootstrap/initialization/prepare',
  query: '/api/edits/bootstrap/initialization/query',
  execute: '/api/edits/bootstrap/initialization/execute',
  acknowledge: '/api/edits/bootstrap/initialization/acknowledge',
  inspect: '/api/edits/bootstrap/inspect',
  revalidate: '/api/edits/bootstrap/revalidate',
  release: '/api/edits/bootstrap/release',
} as const satisfies Record<string, keyof paths>;

export type BootstrapPath = (typeof bootstrapRoutes)[keyof typeof bootstrapRoutes];
export type BootstrapBody<P extends BootstrapPath> = paths[P]['post']['requestBody']['content']['application/json'];

export const authorizationHeader = 'authorization' satisfies keyof NonNullable<paths['/api/edits/bootstrap/revalidate']['post']['parameters']['header']>;
export const hostLeaseHeader = 'x-papeer-host-lease' satisfies keyof NonNullable<paths['/api/edits/bootstrap/revalidate']['post']['parameters']['header']>;
export const admissionHeader = 'x-papeer-admission' satisfies keyof NonNullable<paths['/api/edits/bootstrap/revalidate']['post']['parameters']['header']>;

export type ContextWire = { status: string; reason?: string; leaseId?: string };
export type InspectWire = { authorizationMode?: 'local' | 'provider-online' | 'provider-offline'; admissionId: string; scope: EditScope; peerId: string; fingerprint: string };
export type RevalidateWire = Omit<InspectWire, 'admissionId'>;
export type DiscoveryWire = {
  libraries: { handleId: string; title: string; status: 'available' | 'recovery-required' | 'frozen'; reason?: string }[];
  creations: { requestId: string; title: string; outcome: InitializationOutcome }[];
  canCreateLibrary: boolean;
};
