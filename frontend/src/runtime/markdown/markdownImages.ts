import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { normalizeMarkdown } from '../../lib/normalizeMarkdown.ts';
import type { MarkdownImageResource } from '../edits/contracts.ts';

const id = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const imageUri = new RegExp(`^papeer://resource/(${id})\\?sha256=([0-9a-f]{64})$`);
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
type Node = { type: string; children?: Node[]; identifier?: string; url?: string };

export function parseMarkdownImageUri(uri: string): MarkdownImageResource | null {
  const match = imageUri.exec(uri);
  return match ? { resourceId: match[1], sha256: match[2] } : null;
}
export function formatMarkdownImageUri(reference: MarkdownImageResource): string {
  const uri = `papeer://resource/${reference.resourceId}?sha256=${reference.sha256}`;
  if (!parseMarkdownImageUri(uri)) throw new Error('markdown-image-reference-invalid');
  return uri;
}

/** Parse the same normalized Markdown dialect as MarkdownContent, without rewriting saved text. */
export function analyzeMarkdownImages(content: string): { imageResources: MarkdownImageResource[]; problems: string[] } {
  const tree: Node = parser.parse(normalizeMarkdown(content));
  const definitions = new Map<string, string>(), images: string[] = [], problems = new Set<string>();
  const visit = (node: Node, fn: (node: Node) => void) => { fn(node); node.children?.forEach(child => visit(child, fn)); };
  visit(tree, node => {
    if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });
  visit(tree, node => {
    if (node.type === 'image' && node.url !== undefined) images.push(node.url);
    if (node.type === 'imageReference' && node.identifier !== undefined) {
      const uri = definitions.get(node.identifier); if (uri !== undefined) images.push(uri);
    }
  });
  const references = new Map<string, MarkdownImageResource>();
  for (const uri of images) {
    const reference = parseMarkdownImageUri(uri);
    if (!reference) {
      if (/^papeer:/i.test(uri)) problems.add('markdown-image-uri-invalid');
      continue;
    }
    const previous = references.get(reference.resourceId);
    if (previous && previous.sha256 !== reference.sha256) problems.add('markdown-image-resource-hash-conflict');
    else references.set(reference.resourceId, reference);
  }
  return { imageResources: [...references.values()].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0), problems: [...problems] };
}
export function extractMarkdownImageResources(content: string): MarkdownImageResource[] {
  const result = analyzeMarkdownImages(content);
  if (result.problems.length) throw new Error(result.problems.join(', '));
  return result.imageResources;
}
export function markdownImageMarkup(reference: MarkdownImageResource, alt = '画像'): string {
  // Entities avoid normalizeMarkdown interpreting escaped brackets as math delimiters.
  const escaped = alt.replace(/[\r\n]+/g, ' ').replace(/[&\\`*{}\[\]()#+.!_<>|$]/g, value => `&#${value.charCodeAt(0)};`);
  return `![${escaped}](${formatMarkdownImageUri(reference)})`;
}
export function appendMarkdownImage(content: string, reference: MarkdownImageResource, alt = '画像'): string {
  return `${content}\n\n${markdownImageMarkup(reference, alt)}\n`;
}
