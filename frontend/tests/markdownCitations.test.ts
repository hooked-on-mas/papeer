import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { normalizeMarkdown } from '../src/lib/normalizeMarkdown.ts';
import { appendMarkdownQuote, formatMarkdownCitationUri, markdownCitationLink, markdownQuote, parseMarkdownCitationUri, type CitationTarget } from '../src/runtime/markdown/markdownCitations.ts';

const target: CitationTarget = {
  libraryId: '11111111-1111-1111-1111-111111111111', documentId: '22222222-2222-2222-2222-222222222222',
  pageId: '33333333-3333-3333-3333-333333333333', backgroundRevision: 'abcdefab-abcd-abcd-abcd-abcdefabcdef', surface: 'original',
};
const uri = formatMarkdownCitationUri(target);
test('canonical citations round trip stable IDs, surface and page-local point anchors', () => {
  for (const surface of ['original', 'translated'] as const) for (const anchor of [undefined, { xPt: 0, yPt: 72.5 }, { xPt: 1e-7, yPt: 1e21 }]) {
    const value = { ...target, surface, ...(anchor ? { anchor } : {}) };
    assert.deepEqual(parseMarkdownCitationUri(formatMarkdownCitationUri(value)), value);
  }
  assert.deepEqual(parseMarkdownCitationUri(uri.replace(`backgroundRevision=${target.backgroundRevision}&surface=original`, `surface=original&backgroundRevision=${target.backgroundRevision}`)), target);
});
test('legacy, encoded aliases, malformed identities and ambiguous query strings are rejected', () => {
  for (const invalid of [`papeer://${target.documentId}/3`, `paperdesk://${target.documentId}/3`, uri.replace('papeer:', 'PAPEER:'),
    uri.replace(target.backgroundRevision, target.backgroundRevision.toUpperCase()), uri.replace(target.pageId, '3'),
    uri + '\n', uri + '#anchor', uri + '&extra=1', uri + '&surface=original', uri + '&', uri.replace('surface=original', 'surface=unknown'),
    uri.replace('surface=original', 'surface=%6Friginal'), uri.replace('backgroundRevision=', 'background%52evision='),
    uri.replace('&surface=original', ''), uri + '&xPt=1', uri + '&yPt=2', uri + '&xPt=1&yPt=2&xPt=1']) {
    assert.equal(parseMarkdownCitationUri(invalid), null, invalid);
  }
});
test('anchors reject negative, nonfinite and malformed numbers without inferring page bounds', () => {
  for (const number of ['-1', '-0', 'NaN', 'Infinity', '1e999', '', '0x10', '.5', '1 2', '01']) {
    assert.equal(parseMarkdownCitationUri(`${uri}&xPt=${number}&yPt=0`), null, number);
  }
  for (const xPt of [-1, NaN, Infinity]) assert.throws(() => formatMarkdownCitationUri({ ...target, anchor: { xPt, yPt: 0 } }), /invalid/);
  assert.throws(() => formatMarkdownCitationUri({ ...target, pageId: '3' }), /invalid/);
});
test('quote body and link label remain literal through the renderer Markdown dialect', () => {
  const body = '# title\n\n![image](https://example.com/x) <script>bad</script> $math$\n```\n> quote & \\[x\\]';
  const label = 'source ](javascript:bad) ![other] <b> & $x$';
  const result = markdownQuote(body, target, label);
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(normalizeMarkdown(result));
  type Node = { type: string; value?: string; url?: string; children?: Node[] };
  const nodes: Node[] = [];
  const visit = (node: Node) => { nodes.push(node); node.children?.forEach(visit); }; visit(tree);
  assert.equal(nodes.filter(node => node.type === 'blockquote').length, 1);
  // GFM recognizes plain external URLs even after entity decoding; no injected Markdown links survive.
  assert.deepEqual(nodes.filter(node => node.type === 'link').map(node => node.url), ['https://example.com/x', uri]);
  assert.equal(nodes.filter(node => ['image', 'html', 'code', 'inlineCode', 'math', 'inlineMath', 'heading'].includes(node.type)).length, 0);
  assert.ok(nodes.some(node => node.type === 'text' && node.value === label));
  assert.ok(nodes.some(node => node.type === 'text' && node.value?.includes('![image](')));
  assert.equal(markdownCitationLink(target), `[出典](${uri})`);
  assert.equal(appendMarkdownQuote('body \n', 'quoted', target), `body \n\n\n> quoted\n\n[出典](${uri})\n`);
});

test('appending a quote preserves every existing body byte including Markdown hard-break whitespace', () => {
  for (const content of ['', 'body  ', 'body\r\n\t\r\n', 'body\n\n\n', '本文\u00a0']) {
    assert.equal(appendMarkdownQuote(content, 'quote', target), `${content}\n\n${markdownQuote('quote', target)}\n`);
  }
});
