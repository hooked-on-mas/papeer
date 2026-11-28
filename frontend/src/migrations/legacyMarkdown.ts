import type { MarkdownImageResource, MarkdownSnapshot } from '../runtime/edits/contracts.ts';
import { assertSnapshot } from '../runtime/edits/editModel.ts';
import { resourceHash } from '../runtime/edits/contentPublication.ts';
import { migrationStableId } from './stableId.ts';
import { resourceSource, stagingFail, type IdEntry, type MarkdownImagePort, type MarkdownRow, type NotConverted, type PaperRow, type ProvenanceRow,
  type ResourceDescriptor } from './legacyStagingInput.ts';

// One legacy Markdown note -> one MarkdownSnapshot (work B7-e, DESIGN-r161-b7-staging.md 7.3 item 2).
//
// The body is `note_state.content` (the table the legacy app reads; `note.md` is its mirror, papeer/core/notes.py:104-107, and must equal it).
// Evidence for the image rule (IMPL-r161-b7e.md section 1.2):
//  - The legacy app writes a capture into the note as `media/<name>.png`, relative to the NOTE's own paper folder
//    (papeer/core/paths.py:269-273, notes.py:55-71 own_media; the reader resolves `media/<name>` against the note itself,
//    frontend/src/lib/markdownUrl.ts mediaRequestPath). The files are the manifest entries ('papers', <note id>, 'media', <name>).
//  - The canonical dataset refers to an image as `![alt](papeer://resource/<resourceId>?sha256=<sha256>)` and lists it in `imageResources`
//    (runtime/markdown/markdownImages.ts; papeer/core/edits/resources.py assert_resource_bindings checks the sha256 and an image media type).
//    Canonical previews do not show any other relative image (canonicalMarkdownUrl.ts).
// So a note is converted with images ONLY when every image in it is either an absolute http(s) URL (kept as it is) or exactly the inline form
// `![..](media/<name>.png)` of an entry of the note's own media folder. The rewrite is a textual replacement of that URL, then verified:
//  (1) the number of replaced URLs equals the number of image nodes the markdown parser finds with such a URL, AND the parser finds no image with a
//      `media/<name>.png` URL in the new text. The second half matters (review medium 1): the count alone is a total, so a match that is not an image
//      node (a link URL, a code span) could cancel out an image that was not replaced (an angle-bracket URL, a reference definition) and the text
//      of the link or code span would be rewritten silently. Now such a note is refused;
//  (2) the canonical analyzer (analyzeMarkdownImages, through the injected port) finds exactly the expected resources in the new text and no problem
//      (it ignores relative images, which is why (1) needs its own look at the new text);
//  (3) undoing the replacement reproduces the original text exactly (this holds for any one-to-one replacement, so it only catches a body that
//      already contained the canonical URI as text).
// What is NOT refused: a `media/<name>.png` that the parser does not see as an image at all (raw HTML, a link, prose) when the note has no inline
// image to convert. It stays as text and is reported (`markdown-media-reference-retained`).
// Anything else (another relative URL, /api/papers/.., file:, data:, a papeer: URI, a missing or non-PNG media entry) is NOT converted:
// the note is blocked (`markdown-media-not-converted`). Nothing is guessed.
//
// Not converted, kept as TEXT: legacy citation links `papeer://<paper id>/<page>` and `papeer://<owner>/attachment/<id>`. The canonical form is a different
// URI (markdownCitations.ts: "No legacy page-number URLs"), so they stay in the body unchanged and are reported (`markdown-legacy-links-retained`).
export const MARKDOWN_BLOCKED = ['markdown-state-missing', 'markdown-content-unreadable', 'markdown-revision-invalid', 'markdown-mirror-mismatch',
  'markdown-mirror-unchecked', 'markdown-media-not-converted', 'markdown-media-missing', 'markdown-media-resource-missing', 'markdown-media-type-unsupported'] as const;
export type MarkdownConversion =
  | { status: 'converted'; sourceId: string; snapshot: MarkdownSnapshot; resources: ResourceDescriptor[]; ids: IdEntry[]; provenance: ProvenanceRow[];
      notConverted: NotConverted[]; imageCount: number }
  | { status: 'blocked'; sourceId: string; reason: (typeof MARKDOWN_BLOCKED)[number] };

const OWN_MEDIA = /^media\/([A-Za-z0-9_.-]+\.png)$/;
// The inline form only: `](media/<name>.png)` or `](media/<name>.png "title")`.
const INLINE_MEDIA = /(\]\()media\/([A-Za-z0-9_.-]+\.png)((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\))/g;
// A reference to a media file that is still in the text after the conversion (raw HTML, a link, prose): it is not an image node, so it is kept as text and reported.
const MEDIA_TEXT = /media\/[A-Za-z0-9_.-]+\.png/g;
const LEGACY_LINK = /(?:papeer|paperdesk):\/\/[0-9a-f]{32}\/(?:[0-9]+|attachment\/[0-9a-f]{32})/g;
const blocked = (sourceId: string, reason: (typeof MARKDOWN_BLOCKED)[number]): MarkdownConversion => ({ status: 'blocked', sourceId, reason });

/** The canonical image reference (runtime/markdown/markdownImages.ts formatMarkdownImageUri; the injected analyzer re-checks every reference made with it). */
const imageUri = (resource: MarkdownImageResource) => `papeer://resource/${resource.resourceId}?sha256=${resource.sha256}`;
const sortResources = (items: MarkdownImageResource[]) => [...items].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0);

export async function convertLegacyMarkdown(input: { libraryId: string; item: PaperRow; note: MarkdownRow; resources: readonly ResourceDescriptor[];
  port: MarkdownImagePort }): Promise<MarkdownConversion> {
  const { libraryId, item, note } = input, noteId = note.id;
  if (item.id !== noteId || item.kind !== 'markdown') stagingFail('staging-conversion-input-mismatch');
  if (note.state === 'missing') return blocked(noteId, 'markdown-state-missing');
  if (note.content === null || note.contentSha256 === null || note.contentBytes === null) return blocked(noteId, 'markdown-content-unreadable');
  if (!note.revision || note.sourceSha256 === null) return blocked(noteId, 'markdown-revision-invalid');
  // The body is re-hashed here (Python and TypeScript hash the same UTF-8 bytes): a body that is not what the row said is an input error.
  const bytes = new TextEncoder().encode(note.content);
  if (bytes.byteLength !== note.contentBytes || await resourceHash(bytes) !== note.contentSha256) stagingFail('staging-conversion-input-mismatch');
  if (note.mirror === 'unchecked') return blocked(noteId, 'markdown-mirror-unchecked');
  if (note.mirror !== 'match') return blocked(noteId, 'markdown-mirror-mismatch');

  // ---- images ---------------------------------------------------------------------------------------------------------------------
  const urls = input.port.imageUrls(note.content);
  const own = urls.filter(url => OWN_MEDIA.test(url));
  if (urls.some(url => !OWN_MEDIA.test(url) && !/^https?:\/\/[^/?#\s]+/i.test(url))) return blocked(noteId, 'markdown-media-not-converted');
  const used = new Map<string, ResourceDescriptor>();
  let content = note.content;
  if (own.length) {
    let replaced = 0;
    const rewrite = (text: string, map: (name: string) => string) => text.replace(INLINE_MEDIA, (_all, open: string, name: string, close: string) => { replaced++; return open + map(name) + close; });
    // Resolve every referenced name first (a missing entry blocks the note before anything is rewritten).
    for (const name of new Set(own.map(url => OWN_MEDIA.exec(url)![1]))) {
      const entry = note.media.find(media => media.name === name);
      if (!entry) return blocked(noteId, 'markdown-media-missing');
      const key = ['papers', noteId, 'media', name];
      const resource = input.resources.find(candidate => candidate.kind === 'image' && candidate.sourceKey.join('\0') === key.join('\0'));
      if (!resource) return blocked(noteId, 'markdown-media-resource-missing');
      if (resource.sha256 !== entry.sha256 || resource.byteLength !== entry.byteLength) stagingFail('staging-conversion-resource-mismatch');
      if (await migrationStableId(libraryId, 'resource', resourceSource(resource)) !== resource.resourceId) stagingFail('staging-conversion-resource-mismatch');
      if (resource.mediaType !== 'image/png') return blocked(noteId, 'markdown-media-type-unsupported');
      used.set(name, resource);
    }
    const forward = (name: string) => imageUri({ resourceId: used.get(name)!.resourceId, sha256: used.get(name)!.sha256 });
    content = rewrite(note.content, forward);
    if (replaced !== own.length) return blocked(noteId, 'markdown-media-not-converted');            // (1) the totals agree ...
    if (input.port.imageUrls(content).some(url => OWN_MEDIA.test(url))) return blocked(noteId, 'markdown-media-not-converted');   // (1) ... and no media image was left unreplaced
    const expected = sortResources([...used.values()].map(resource => ({ resourceId: resource.resourceId, sha256: resource.sha256 })));
    const analysis = input.port.analyze(content);
    if (analysis.problems.length || JSON.stringify(analysis.imageResources) !== JSON.stringify(expected)) return blocked(noteId, 'markdown-media-not-converted');   // (2)
    const back = new Map([...used.keys()].map(name => [forward(name), name]));
    let undone = content;
    for (const [uri, name] of back) undone = undone.split(uri).join('media/' + name);
    if (undone !== note.content) return blocked(noteId, 'markdown-media-not-converted');            // (3)
  }

  const imageResources = sortResources([...used.values()].map(resource => ({ resourceId: resource.resourceId, sha256: resource.sha256 })));
  const ids: IdEntry[] = [], stable = async (kind: string, source: string[]) => { const targetId = await migrationStableId(libraryId, kind, source); ids.push({ kind, source, targetId }); return targetId; };
  const id = await stable('markdown-document', [noteId]);
  const version = await stable('markdown-revision', [noteId, note.revision, note.contentSha256]);
  const snapshot: MarkdownSnapshot = { kind: 'markdown', id, version, content, appendIds: [], imageResources };
  assertSnapshot(snapshot);
  const notConverted: NotConverted[] = [];
  const unreferenced = note.media.filter(media => !used.has(media.name)).length;
  if (unreferenced) notConverted.push({ sourceKey: ['papers', noteId, 'media'], kind: 'markdown-media', reason: 'markdown-media-unreferenced', residual: 'markdown-not-converted', count: unreferenced });
  const retained = content.match(MEDIA_TEXT)?.length ?? 0;
  if (retained) notConverted.push({ sourceKey: ['papers', noteId, 'media'], kind: 'markdown-media', reason: 'markdown-media-reference-retained', residual: 'markdown-not-converted', count: retained });
  const links = note.content.match(LEGACY_LINK)?.length ?? 0;
  if (links) notConverted.push({ sourceKey: ['papers', noteId], kind: 'markdown-link', reason: 'markdown-legacy-links-retained', residual: 'markdown-not-converted', count: links });
  return { status: 'converted', sourceId: noteId, snapshot, resources: [...used.values()], ids, imageCount: used.size, notConverted,
    provenance: [{ targetKind: 'markdown', targetId: id, sourceKind: 'row', sourceKey: ['note_state', noteId], sourceSha256: note.sourceSha256 }] };
}
