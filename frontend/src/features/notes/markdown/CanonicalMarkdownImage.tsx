import { useEffect, useState } from 'react';
import type { MarkdownImageResource } from '../../../runtime/edits/contracts';
import type { ContentRepository } from '../../../runtime/edits/ports';
import { isImageMediaType, resourceHash } from '../../../runtime/edits/contentPublication';
import { MarkdownImageView } from './MarkdownImageView';

type Resources = Pick<ContentRepository, 'scope' | 'readResource'>;
/** The caller admits this reference against the current Markdown manifest. */
export function CanonicalMarkdownImage({ reference, resources, alt = '画像', title }: {
  reference: MarkdownImageResource; resources: Resources; alt?: string; title?: string;
}) {
  const { resourceId, sha256 } = reference;
  const key = JSON.stringify([resources.scope.accountId, resources.scope.libraryId, resources.scope.epoch, resourceId, sha256]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; resources: Resources; url?: string; failed?: boolean; release?(): void }>();
  useEffect(() => {
    let active = true, objectUrl = '';
    const release = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ''; } };
    void (async () => {
      const resource = await resources.readResource(resourceId);
      if (!active) return;
      if (!resource || resource.metadata.id !== resourceId || resource.metadata.sha256 !== sha256
        || resource.metadata.byteLength !== resource.bytes.byteLength
        || !isImageMediaType(resource.metadata.mediaType)
        || await resourceHash(resource.bytes) !== sha256) throw new Error('markdown-image-resource-invalid');
      if (!active) return;
      objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(resource.bytes)], { type: resource.metadata.mediaType }));
      setResult({ key, resources, url: objectUrl, release });
    })().catch(() => { if (active) setResult({ key, resources, failed: true }); });
    return () => { active = false; release(); };
  }, [key, resources, resourceId, sha256, attempt]);
  const current = result?.key === key && result.resources === resources ? result : undefined;
  return <MarkdownImageView src={current?.url} alt={alt} title={title} failed={current?.failed}
    onError={() => { current?.release?.(); setResult({ key, resources, failed: true }); }}
    retry={() => { setResult(undefined); setAttempt(value => value + 1); }} />;
}
