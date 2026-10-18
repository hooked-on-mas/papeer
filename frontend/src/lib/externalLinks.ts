/**
 * Web links in PDFs open in the default browser. Only http and https: a paper has no business
 * launching mail clients, file shares or local programs. (The app's capability also allows mailto:,
 * for links in the chat and summary, which the opener plugin opens itself; see
 * src-tauri/capabilities/default.json.)
 */
export function externalHttpUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url.href;
}
