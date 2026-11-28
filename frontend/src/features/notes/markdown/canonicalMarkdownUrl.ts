import { parseMarkdownImageUri } from '../../../runtime/markdown/markdownImages.ts';
import { parseMarkdownCitationUri } from '../../../runtime/markdown/markdownCitations.ts';

/** Canonical resources never fall back to an authenticated legacy/local route. */
export function canonicalMarkdownUrl(url: string, kind: 'image' | 'link'): string {
  if (/[\u0000-\u0020\u007f\\]/.test(url) || /^[\\/]{2}/.test(url)) return '';
  if (kind === 'image' ? parseMarkdownImageUri(url) : parseMarkdownCitationUri(url)) return url;
  if (/^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(url)) return url;
  return kind === 'link' && /^(?:mailto:[^?#]+|#)/i.test(url) ? url : '';
}
