import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Page, ResourceMetadata } from '../../runtime/edits/contracts';
import type { ContentRepository } from '../../runtime/edits/ports';
import { canonicalJson } from '../../runtime/edits/editModel';
import { assertCanonicalPdfResource, canonicalPdfResourceBinding, readCanonicalPdfResourceBytes,
  type CanonicalPdfAsset, type CanonicalPdfResourceBinding, type CanonicalPdfResourceIdentity } from './pdf/canonicalPdfResource';

type Resources = Pick<ContentRepository, 'scope' | 'readResource'>;
type Request = { resources: Resources; identity: CanonicalPdfResourceIdentity };
type Proof = { request: Request; generation: number; metadata: Readonly<ResourceMetadata>; byteLength: number; url: string };
const failure = 'PDFを読み込めません。保存データを確認して再試行してください。';

/** Local resource proof and current-page admission have separate lifetimes.
 * Page/annotation changes never restart a verified resource read or create a URL. */
export function useDocumentPdfAsset(resources: Resources, page: Page | null, attempt: number): {
  asset: CanonicalPdfAsset | null; error: string;
} {
  const background = page?.background.kind === 'pdf' ? page.background : null;
  const resourceKey = background ? canonicalJson({ scope: resources.scope,
    resourceId: background.resourceId, sourceRevision: background.sourceRevision, attempt }) : null;
  const request = useMemo<Request | null>(() => {
    if (!resourceKey) return null;
    const { scope, resourceId, sourceRevision } = JSON.parse(resourceKey) as CanonicalPdfResourceIdentity;
    return { resources, identity: Object.freeze({ scope: Object.freeze(scope), resourceId, sourceRevision }) };
  }, [resources, resourceKey]);

  let currentBinding: CanonicalPdfResourceBinding | null = null;
  let invalidPage = false;
  if (background && page) {
    try { currentBinding = canonicalPdfResourceBinding(resources.scope, page); }
    catch { invalidPage = true; }
  }
  // Canonical serialization deliberately excludes annotations and lifecycle versions.
  // Parse the immutable descriptor rather than depending on the mutable Page object.
  const pageKey = currentBinding ? canonicalJson(currentBinding) : null;
  const binding = useMemo<CanonicalPdfResourceBinding | null>(() => {
    if (!pageKey) return null;
    const value = JSON.parse(pageKey) as CanonicalPdfResourceBinding;
    return Object.freeze({ ...value, scope: Object.freeze(value.scope) });
  }, [pageKey]);
  const [proof, setProof] = useState<Proof | null>(null);
  const [failed, setFailed] = useState<{ request: Request; generation: number } | null>(null);
  const lifetime = useRef({ active: false, generation: 0 });
  const requested = useRef(request); requested.current = request;
  useLayoutEffect(() => {
    const current = lifetime.current, generation = ++current.generation;
    current.active = true;
    let url: string | undefined;
    const alive = () => current.active && current.generation === generation && requested.current === request
      && !!request && canonicalJson(request.resources.scope) === canonicalJson(request.identity.scope);
    if (request) {
      void readCanonicalPdfResourceBytes(request.identity, request.resources).then(value => {
        if (!alive()) return;
        // A proof owns its copies. Metadata cannot be mutated after admission.
        const metadata = value.metadata;
        metadata.pdfPages?.forEach(Object.freeze);
        if (metadata.pdfPages) Object.freeze(metadata.pdfPages);
        Object.freeze(metadata);
        url = URL.createObjectURL(new Blob([Uint8Array.from(value.bytes)], { type: 'application/pdf' }));
        if (!alive()) { URL.revokeObjectURL(url); url = undefined; return; }
        setProof({ request, generation, metadata, byteLength: value.bytes.length, url });
      }).catch(() => { if (alive()) setFailed({ request, generation }); });
    }
    return () => {
      current.active = false; current.generation++;
      if (url) URL.revokeObjectURL(url);
    };
  }, [request]);

  const active = !!request && lifetime.current.active
    && canonicalJson(resources.scope) === canonicalJson(request.identity.scope);
  const verified = active && proof?.request === request && proof.generation === lifetime.current.generation ? proof : null;
  let validPage = false;
  if (binding && verified) {
    // Always revalidate the currently requested page, including while an older
    // resource effect has not cleaned up. A failure never discards valid bytes.
    try { assertCanonicalPdfResource(binding, verified.metadata, verified.byteLength); validPage = true; }
    catch { invalidPage = true; }
  }
  const asset = useMemo<CanonicalPdfAsset | null>(() => validPage && binding && verified
    ? Object.freeze({ binding, url: verified.url, metadata: verified.metadata }) : null, [validPage, binding, verified]);
  const resourceFailed = active && failed?.request === request && failed.generation === lifetime.current.generation;
  return { asset, error: invalidPage || resourceFailed ? failure : '' };
}
