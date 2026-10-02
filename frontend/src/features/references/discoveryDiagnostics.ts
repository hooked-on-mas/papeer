/** Existing servers and saved maps expose diagnostic strings. Keep known coverage
 * notices separate, and treat unfamiliar messages as failures so none are hidden. */
export function discoveryDiagnostics(warnings: string[]) {
  const notices: string[] = [], errors: string[] = [];
  for (const message of warnings) {
    const coverage = /(?:で区切りました。|取得上限までを対象にしました。|までを対象にしました。|ため除外しました。)$/.test(message)
      || message.startsWith("Semantic Scholarの参考文献情報に取得上限・欠落があります。");
    (coverage ? notices : errors).push(message);
  }
  return { notices, errors };
}
