import { defaultUrlTransform } from "react-markdown";

/** A citation link as the sidecar writes it (service.py) and the reader opens it: papeer://<paper id>/<page>. */
export const CITATION_URL = /^(?:papeer|paperdesk):\/\/([^/\s?#]+)\/(\d+)$/;

/** An image name the sidecar's media route serves (papers.py get_paper_media). */
const MEDIA_NAME = "[A-Za-z0-9_.-]+\\.png";
/** papers/<id>/media/<name> at the end of an image path: older article.md files embed it as an absolute file:// URI. */
const LIBRARY_MEDIA = new RegExp(`(?:^|/)papers/([0-9a-f]{32})/media/(${MEDIA_NAME})$`);
const SIDECAR_MEDIA = new RegExp(`^/api/papers/[0-9a-f]{32}/media/${MEDIA_NAME}$`);
const OWN_MEDIA = new RegExp(`^media/(${MEDIA_NAME})$`);

/**
 * react-markdown's urlTransform. Summaries and notes come from AI output, which a PDF can steer, so
 * links keep react-markdown's safe protocols plus citation links of exactly the papeer://<id>/<page>
 * form (legacy paperdesk:// too); any other papeer: or file: URL, or one naming another host
 * without a scheme (//host, \\host), becomes "" and is not shown.
 *
 * An image in a paper's media folder, however its path was written (a file:// URI in older
 * article.md files), becomes the sidecar's /api/papers/<id>/media/<name>: only the paper id and the
 * image name are kept, so a file: URL never reaches the page. The renderer adds the token
 * (mediaRequestPath, then authorizedUrl).
 */
export function markdownUrlTransform(url: string, key: string): string {
  if (/^(?:papeer|paperdesk):/i.test(url)) return CITATION_URL.test(url) ? url : "";
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
