import { MarkdownContent } from '../../../components/ui/MarkdownContent';
import { createContext, useContext, useMemo, useState, type ComponentProps } from 'react';
import { type Components, type UrlTransform } from 'react-markdown';
import type { MarkdownImageResource } from '../../../runtime/edits/contracts';
import type { ContentRepository } from '../../../runtime/edits/ports';
import { parseMarkdownImageUri } from '../../../runtime/markdown/markdownImages';
import { parseMarkdownCitationUri } from '../../../runtime/markdown/markdownCitations';
import { CanonicalMarkdownImage } from './CanonicalMarkdownImage';
import { ContentNavigationContext } from '../../reader/navigation/ContentNavigationContext';
import { canonicalMarkdownUrl } from './canonicalMarkdownUrl';
import { ExternalMarkdownImage } from './MarkdownImageView';

type ImageDisplay = {
  imageResources: readonly MarkdownImageResource[];
  resources: Pick<ContentRepository, 'scope' | 'readResource'>;
  imagesEnabled?: boolean;
};
const ImageDisplayContext = createContext<ImageDisplay | null>(null);
const previewUrlTransform: UrlTransform = (url, key, node) => key === 'src' && node.tagName === 'img' ? canonicalMarkdownUrl(url, 'image')
  : key === 'href' && node.tagName === 'a' ? canonicalMarkdownUrl(url, 'link') : '';

// ReactMarkdown uses this function as an element type: keep it stable across editor/poll updates.
function PreviewImage({ src, alt, title }: ComponentProps<'img'>) {
  const display = useContext(ImageDisplayContext);
  if (display?.imagesEnabled === false) return <span role="status">{alt || '画像'}（画像取得を停止しています）</span>;
  const reference = src ? parseMarkdownImageUri(src) : null;
  if (reference) return display?.imageResources.some(image => image.resourceId === reference.resourceId && image.sha256 === reference.sha256)
    ? <CanonicalMarkdownImage reference={reference} resources={display.resources} alt={alt} title={title} />
    : <span role="status">{alt || '画像'}（画像参照を確認できません）</span>;
  return src ? <ExternalMarkdownImage src={src} alt={alt ?? ''} title={title} />
    : <span role="status">{alt || '画像'}（画像参照を確認できません）</span>;
}
function PreviewLink({ href, children, title }: ComponentProps<'a'>) {
  const navigation = useContext(ContentNavigationContext);
  const target = href ? parseMarkdownCitationUri(href) : null;
  if (target) return navigation ? <a href={href} title={title} className="text-primary hover:underline"
    onClick={event => { event.preventDefault(); void navigation.openCitation(target); }}>{children}</a> : <span>{children}</span>;
  return href ? <a href={href} title={title} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>;
}
const previewComponents: Components = { img: PreviewImage, a: PreviewLink };

export function CanonicalMarkdownPreview({ content, imageResources, resources }: { content: string } & ImageDisplay) {
  const [imagesEnabled, setImagesEnabled] = useState(true);
  const display = useMemo(() => ({ imageResources, resources, imagesEnabled }), [imageResources, resources, imagesEnabled]);
  return <ImageDisplayContext.Provider value={display}>
    <div className="summary-prose min-w-0 break-words p-3"><label><input type="checkbox" aria-label="画像を読み込む" checked={imagesEnabled} onChange={event => setImagesEnabled(event.target.checked)} />画像を読み込む</label><MarkdownContent content={content}
      urlTransform={previewUrlTransform} components={previewComponents} /></div>
  </ImageDisplayContext.Provider>;
}

