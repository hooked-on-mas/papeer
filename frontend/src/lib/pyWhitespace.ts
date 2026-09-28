/**
 * Whitespace as Python has it (str.isspace, what str.strip() removes and re's \s matches), for the rules
 * the frontend shares with the sidecar. JavaScript's \s and trim() differ at the edges: they also take
 * U+FEFF, and leave U+001C to U+001F and U+0085. tests/fixtures/python_whitespace.json lists Python's,
 * which this must match exactly.
 */
export const PY_SPACE = "[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

const edges = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "g");

/** `value` without the whitespace at either end, as Python's str.strip() gives it. */
export function pyStrip(value: string): string {
  return value.replace(edges, "");
}
