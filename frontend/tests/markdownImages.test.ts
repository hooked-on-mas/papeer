import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeMarkdownImages, appendMarkdownImage, extractMarkdownImageResources, formatMarkdownImageUri, markdownImageMarkup, parseMarkdownImageUri } from '../src/runtime/markdown/markdownImages.ts';

const first = { resourceId: '10000000-0000-0000-0000-000000000001', sha256: 'a'.repeat(64) };
const second = { resourceId: '20000000-0000-0000-0000-000000000002', sha256: 'b'.repeat(64) };
const uri = formatMarkdownImageUri(first), otherUri = formatMarkdownImageUri(second);

test('inline and resolved reference images deduplicate and sort canonical resources', () => {
  const content = `![second](${otherUri})\n![one][My Image]\n![same][]\n![shortcut]\n\n[my image]: ${uri}\n[same]: ${uri}\n[shortcut]: ${uri}`;
  assert.deepEqual(analyzeMarkdownImages(content), { imageResources: [first, second], problems: [] });
});
test('code, math, unused definitions, raw HTML and ordinary links do not declare images', () => {
  const image = `![hidden](${uri})`;
  for (const content of [`\`${image}\``, `\`\`\`md\n${image}\n\`\`\``, `    ${image}`, `$${image}$`, `$$\n${image}\n$$`,
    `[unused]: ${uri}`, `<img src="${uri}">`, `[link](${uri})`, `![unresolved][missing]`, `\\!${image.slice(1)}`]) {
    assert.deepEqual(extractMarkdownImageResources(content), [], content);
  }
});
test('normalization and GFM share the rendering dialect and duplicate definitions use the first', () => {
  const content = `| image |\n| --- |\n| ![one][name] |\n\n[name]: ${uri}\n[name]: ${otherUri}\n`;
  assert.deepEqual(extractMarkdownImageResources(content), [first]);
  assert.deepEqual(extractMarkdownImageResources(`\\[ ![math](${uri}) \\]`), []);
});
test('invalid internal image destinations and conflicting hashes report errors without destroying the draft', () => {
  for (const invalid of [uri + '&extra=1', uri + '#fragment', uri.replace('?sha256=', '?hash='), uri.replace(first.resourceId, 'invalid'),
    uri.replace('papeer:', 'PAPEER:'), 'papeer://resource/missing']) {
    assert.equal(parseMarkdownImageUri(invalid), null);
    assert.deepEqual(analyzeMarkdownImages(`![bad](${invalid})`).problems, ['markdown-image-uri-invalid']);
    assert.throws(() => extractMarkdownImageResources(`![bad](${invalid})`), /markdown-image-uri-invalid/);
  }
  const conflicting = formatMarkdownImageUri({ ...first, sha256: second.sha256 });
  assert.deepEqual(analyzeMarkdownImages(`![one](${uri}) ![two](${conflicting})`).problems, ['markdown-image-resource-hash-conflict']);
  assert.deepEqual(extractMarkdownImageResources('![external](https://example.com/image.png)'), []);
});
test('image insertion escapes alt text so it cannot introduce additional images or links', () => {
  const alt = `quote ](${otherUri}) ![injected]\nline \\ end`;
  const markup = markdownImageMarkup(first, alt);
  assert.deepEqual(extractMarkdownImageResources(markup), [first]);
  assert.deepEqual(parseMarkdownImageUri(uri), first);
  assert.equal(appendMarkdownImage('body  \n', first, 'alt'), `body  \n\n\n![alt](${uri})\n`);
  assert.throws(() => formatMarkdownImageUri({ ...first, sha256: 'bad' }), /invalid/);
});
