import type { DocumentSnapshot, ResourceMetadata } from '../../../../runtime/edits/contracts.ts';

/** The caller freezes branch selection and resolves previews and text drafts before invoking the worker. */
export type PdfExportRequest = {
  snapshot: DocumentSnapshot;
  resources: readonly { metadata: ResourceMetadata; bytes: Uint8Array }[];
  fonts: readonly { family: string; bytes: Uint8Array }[];
};
