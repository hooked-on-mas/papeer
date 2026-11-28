import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalMarkdownUrl } from '../src/features/notes/markdown/canonicalMarkdownUrl.ts';
const id = '00000000-0000-4000-8000-000000000001', hash = 'a'.repeat(64);
test('canonical Markdown images only admit verified resource syntax or explicit HTTP images', () => {
  const resource = `papeer://resource/${id}?sha256=${hash}`;
  assert.equal(canonicalMarkdownUrl(resource, 'image'), resource);
  assert.equal(canonicalMarkdownUrl('https://example.test/image.png?q=1', 'image'), 'https://example.test/image.png?q=1');
  for (const url of ['papeer://resource/not-an-id', `papeer://resource/${id}?sha256=${hash}#other`, '/api/settings', 'media/a.png', 'data:image/svg+xml,<svg/>', 'blob:https://example.test/a', 'file:///secret.png', '//example.test/a', '/\\example.test/a', 'javascript:alert(1)', 'https:\\example.test/a', 'https://example.test/a\n'])
    assert.equal(canonicalMarkdownUrl(url, 'image'), '', url);
});
test('canonical Markdown links retain citations and web/mail links but refuse local or executable targets', () => {
  const citation = `papeer://citation/${id}/${id}/${id}?background=${id}`;
  const valid = `papeer://citation/${id}/${id}/${id}?backgroundRevision=${id}&surface=original`;
  assert.equal(canonicalMarkdownUrl(valid, 'link'), valid);
  assert.equal(canonicalMarkdownUrl(valid, 'image'), '');
  // Citation grammar is separately tested; web/mail/fragment allowlisting must not admit other app routes.
  for (const url of ['https://example.test/paper', 'http://example.test/paper', 'mailto:reader@example.test', '#section']) assert.equal(canonicalMarkdownUrl(url, 'link'), url);
  for (const url of [citation, 'papeer://resource/anything', 'file:///secret', 'javascript:alert(1)', 'data:text/html,test', 'blob:https://example.test/a', '//example.test', '/api/settings', '../secret', 'https://example.test/\t']) assert.equal(canonicalMarkdownUrl(url, 'link'), '', url);
});
