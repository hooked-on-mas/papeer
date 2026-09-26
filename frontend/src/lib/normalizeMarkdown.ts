const CITATION = String.raw`\[p\.\s*\d+\]\(paperdesk:\/\/[^\s/)]+\/\d+\)`;
const CITATIONS_ONLY = new RegExp(String.raw`^[\s\[\],、]*(?:${CITATION}[\s\[\],、]*)+$`);

/** Only unfold lines with an unambiguous header, delimiter row and matching data rows. */
function repairCollapsedTables(content: string): string {
  return content.replace(/^ {0,3}\\?\|[^\n]+$/gm, (line) => {
    const rows = line.trim().replace(/^\\\|/, "|").split(/(?<!\\)\|[ \t]*(?=\|)/)
      .map((row, index, all) => index < all.length - 1 ? `${row}|` : row);
    if (rows.length < 3) return line;
    const cells = rows.map((row) => {
      if (!row.startsWith("|") || !row.endsWith("|")) return [];
      return row.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim());
    });
    const width = cells[0].length;
    if (width < 2 || cells.some((row) => row.length !== width)
      || !cells[1].every((cell) => /^:?-{3,}:?$/.test(cell))) return line;
    return rows.join("\n");
  });
}

/** Repair common generated Markdown issues without changing the saved article. */
export function normalizeMarkdown(content: string, options: { dropRules?: boolean } = {}): string {
  const protectedParts: string[] = [];
  // Keep code and math out of the prose repairs. A per-document marker avoids
  // confusing literal user content with our temporary placeholders.
  let marker = "\uE000";
  while (content.includes(marker)) marker += "\uE000";
  const protect = (value: string) => `${marker}${protectedParts.push(value) - 1}${marker}`;
  const text = content.replace(
    /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\2[^\S\n]*(?:\n|$))|(`+)[^\n]*?\3|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<![\\$])\$(?!\$)[^\n$]+\$/gm,
    (value) => {
      // Models sometimes wrap page citations in backticks, which renders them as code.
      if (/^`[^`]/.test(value) && CITATIONS_ONLY.test(value.replace(/^`+|`+$/g, ""))) {
        return value.replace(/^`+|`+$/g, "");
      }
      if (/^ {0,3}[`~]/.test(value)) return protect(value);
      const display = value.startsWith("\\[") || value.startsWith("$$");
      const delimiterLength = value.startsWith("\\") || display ? 2 : 1;
      const citations: string[] = [];
      const formula = value.slice(delimiterLength, -delimiterLength).replace(
        new RegExp(CITATION, "g"),
        (citation) => { citations.push(citation); return ""; },
      ).trim();
      const math = display ? `\n\n$$\n${formula}\n$$\n\n` : `$${formula}$`;
      return protect(math) + (citations.length ? ` ${citations.join(" ")} ` : "");
    },
  );
  // Citations render as labels, so brackets around them and separators between them are noise.
  const labeled = repairCollapsedTables(text)
    .replace(new RegExp(String.raw`\[+\s*((?:${CITATION}[\s,、]*)+?)\s*\]+`, "g"), "$1")
    .replace(new RegExp(String.raw`(${CITATION})\s*[,、]\s*(?=${CITATION})`, "g"), "$1 ");
  // In summaries, horizontal rules between sections only add blank space; headings already separate them.
  const withoutRules = options.dropRules
    ? labeled.replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*(?:\n|$)/gm, "")
    : labeled;
  // CommonMark does not recognize emphasis with inner whitespace, or closing
  // punctuation immediately followed by Japanese text. Supply word boundaries.
  const repaired = withoutRules.replace(/\*\*([^*\n]+?)\*\*/g, (_match, body: string) =>
    body.trim() ? ` **${body.trim()}** ` : _match,
  );
  return repaired.replace(new RegExp(`${marker}(\\d+)${marker}`, "g"),
    (_match, index: string) => protectedParts[Number(index)]);
}
