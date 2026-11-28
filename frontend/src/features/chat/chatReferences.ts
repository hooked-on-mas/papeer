/** Separate the service's generated footer, including in already saved messages. */
export function splitChatReferences(content: string): { answer: string; note: string; label: string } {
  const footer = /\r?\n\r?\n---\r?\n\*([^\r\n]+)\*\s*$/.exec(content);
  const unchanged = { answer: content, note: "", label: "" };
  if (!footer) return unchanged;
  const note = footer[1];
  const search = /^キーワード検索で選んだ(?:(\d+)ページ(?:と)?)?(?:(\d+)件の資料（HTML）)?の抜粋を参照しています：/.exec(note);
  const fullText = /^選択した(?:論文|ノート)の(全文テキスト(?:と資料（HTML）の本文)?|資料（HTML）の本文)を参照しています[。：]/.exec(note);
  // Leave ordinary answer text alone; only the service's known footer is folded.
  if (!search && !fullText) return unchanged;
  const parts = search
    ? [search[1] && `${search[1]}ページ`, search[2] && `資料${search[2]}件`].filter(Boolean)
    : [fullText![1].startsWith("全文") ? "全文" : "資料（HTML）"];
  if (fullText?.[1].includes("全文テキストと")) parts.push("資料（HTML）");
  if (note.includes(" 追加参照：")) parts.push("追加ページあり");
  return { answer: content.slice(0, footer.index), note, label: `参照範囲：${parts.join("・")}` };
}
