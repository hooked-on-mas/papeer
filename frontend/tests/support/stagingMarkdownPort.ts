import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { normalizeMarkdown } from '../../src/lib/normalizeMarkdown.ts';
import { analyzeMarkdownImages } from '../../src/runtime/markdown/markdownImages.ts';
import type { MarkdownImagePort } from '../../src/migrations/legacyStagingInput.ts';

// The Markdown parser the staging converters are given (work B7-e). The converters themselves import no Markdown package (the domain layer; see
// tests/sharedEntries.test.mjs), so the test bridge injects the product's own parsing here: the same unified / remark-parse / gfm / math stack and the same
// normalizeMarkdown as runtime/markdown/markdownImages.ts `analyzeMarkdownImages`, which is also what `analyze` calls. A production wiring (work B7-f / B7-h)
// must give the converters an equivalent port; the tests in legacyStagingConversion.test.ts are its acceptance check.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
type Node = { type: string; children?: Node[]; identifier?: string; url?: string };

/** The URL of every image the parser sees, in document order (an image through a reference definition counts with the definition's URL). */
export function markdownImageUrls(content: string): string[] {
  const tree = parser.parse(normalizeMarkdown(content)) as Node;
  const definitions = new Map<string, string>(), urls: string[] = [];
  const visit = (node: Node, fn: (node: Node) => void) => { fn(node); node.children?.forEach(child => visit(child, fn)); };
  visit(tree, node => { if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
  visit(tree, node => {
    if (node.type === 'image' && node.url !== undefined) urls.push(node.url);
    if (node.type === 'imageReference' && node.identifier !== undefined) { const uri = definitions.get(node.identifier); if (uri !== undefined) urls.push(uri); }
  });
  return urls;
}
export const markdownImagePort: MarkdownImagePort = { imageUrls: markdownImageUrls, analyze: analyzeMarkdownImages };
