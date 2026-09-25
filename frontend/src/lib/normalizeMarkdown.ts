/** Repair common generated Markdown issues without changing the saved article. */
export function normalizeMarkdown(content: string): string {
  const protectedParts: string[] = [];
  // Keep code and math out of the prose repairs. A per-document marker avoids
  // confusing literal user content with our temporary placeholders.
  let marker = "\uE000";
  while (content.includes(marker)) marker += "\uE000";
  const protect = (value: string) => `${marker}${protectedParts.push(value) - 1}${marker}`;
  const text = content.replace(
    /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\2[^\S\n]*(?:\n|$))|(`+)[^\n]*?\3|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<![\\$])\$(?!\$)[^\n$]+\$/gm,
    (value) => {
      if (/^ {0,3}[`~]/.test(value)) return protect(value);
      const display = value.startsWith("\\[") || value.startsWith("$$");
      const delimiterLength = value.startsWith("\\") || display ? 2 : 1;
      const citations: string[] = [];
      const formula = value.slice(delimiterLength, -delimiterLength).replace(
        /\[p\.\s*\d+\]\(paperdesk:\/\/[^\s/)]+\/\d+\)/g,
        (citation) => { citations.push(citation); return ""; },
      ).trim();
      const math = display ? `\n\n$$\n${formula}\n$$\n\n` : `$${formula}$`;
      return protect(math) + (citations.length ? ` ${citations.join(" ")} ` : "");
    },
  );
  // CommonMark does not recognize emphasis with inner whitespace, or closing
  // punctuation immediately followed by Japanese text. Supply word boundaries.
  const repaired = text.replace(/\*\*([^*\n]+?)\*\*/g, (_match, body: string) =>
    body.trim() ? ` **${body.trim()}** ` : _match,
  );
  return repaired.replace(new RegExp(`${marker}(\\d+)${marker}`, "g"),
    (_match, index: string) => protectedParts[Number(index)]);
}
