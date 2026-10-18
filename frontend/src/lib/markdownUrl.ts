import { defaultUrlTransform } from "react-markdown";

/** A citation link as the sidecar writes it (service.py) and the reader opens it: papeer://<paper id>/<page>. */
export const CITATION_URL = /^(?:papeer|paperdesk):\/\/([^/\s?#]+)\/(\d+)$/;

/** A Markdown link to a page of a paper, as the sidecar writes citations: [p.N](papeer://<paper id>/<N>). */
export function citationLink(paperId: string, page: number): string {
  return `[p.${page}](papeer://${paperId}/${page})`;
}

/**
 * A citation of an HTML document the sidecar gave to the chat as evidence (service.py link_citations):
 * papeer://<owner id>/attachment/<document id>, both exactly 32 lowercase hex characters. It opens the
 * saved document of that owner (never a page of the paper).
 */
export const DOCUMENT_URL = /^papeer:\/\/([0-9a-f]{32})\/attachment\/([0-9a-f]{32})$/;

/** The owner and document a citation of a document names, or null for any other link. */
export function documentCitation(url: string): { owner: string; document: string } | null {
  const match = DOCUMENT_URL.exec(url);
  return match ? { owner: match[1], document: match[2] } : null;
}

/** An image name the sidecar's media route serves (papers.py get_paper_media). */
const MEDIA_NAME = "[A-Za-z0-9_.-]+\\.png";
/** papers/<id>/media/<name> at the end of an image path: older article.md files embed it as an absolute file:// URI. */
const LIBRARY_MEDIA = new RegExp(`(?:^|/)papers/([0-9a-f]{32})/media/(${MEDIA_NAME})$`);
const SIDECAR_MEDIA = new RegExp(`^/api/papers/[0-9a-f]{32}/media/${MEDIA_NAME}$`);
const OWN_MEDIA = new RegExp(`^media/(${MEDIA_NAME})$`);

/**
 * react-markdown's urlTransform. Summaries and notes come from AI output, which a PDF can steer, so
 * links keep react-markdown's safe protocols plus citation links of exactly the papeer://<id>/<page>
 * form (legacy paperdesk:// too) and the papeer://<owner>/attachment/<document> form of an HTML
 * document (32 hex characters each); any other papeer: or file: URL, or one naming another host
 * without a scheme (//host, \\host), becomes "" and is not shown.
 *
 * An image in a paper's media folder, however its path was written (a file:// URI in older
 * article.md files), becomes the sidecar's /api/papers/<id>/media/<name>: only the paper id and the
 * image name are kept, so a file: URL never reaches the page. The renderer adds the token
 * (mediaRequestPath, then authorizedUrl).
 */
export function markdownUrlTransform(url: string, key: string): string {
  if (/^(?:papeer|paperdesk):/i.test(url)) return CITATION_URL.test(url) || DOCUMENT_URL.test(url) ? url : "";
  // //host/... and \\host\... (the browser reads both as another server, never as a network share).
  if (/^[\\/]{2}/.test(url)) return "";
  const isFile = /^file:/i.test(url);
  const safe = isFile ? "" : defaultUrlTransform(url);
  if (key === "src") {
    const media = (isFile ? url : safe).match(LIBRARY_MEDIA);
    if (media) return `/api/papers/${media[1]}/media/${media[2]}`;
  }
  return safe;
}

/**
 * The sidecar path an <img> src (after markdownUrlTransform) loads from, or null for any other
 * image: /api/papers/<id>/media/<name> as the transform writes it, or media/<name> relative to the
 * paper shown (`owner`). Only these get the token; the path is checked again here, so no other
 * sidecar route can be reached from Markdown with it.
 */
export function mediaRequestPath(src: string, owner: string | null | undefined): string | null {
  if (SIDECAR_MEDIA.test(src)) return src;
  const own = src.match(OWN_MEDIA);
  return own && owner ? `/api/papers/${owner}/media/${own[1]}` : null;
}
