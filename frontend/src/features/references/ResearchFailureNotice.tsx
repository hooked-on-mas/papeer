import type { ResearchRecord } from "./researchHooks";

export function ResearchFailureNotice({ failure, openLink }: {
  failure: NonNullable<ResearchRecord["last_failure"]>; openLink: (url: string) => void;
}) {
  return <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-2 text-xs min-w-0" role="alert" aria-label="最後の文献照合エラー">
    <p className="font-medium">検索結果をこの文献と照合できませんでした</p>
    <p className="break-words">対象：{failure.title}</p>
    <p className="text-muted-foreground leading-relaxed">別の文献やプレプリント・出版版の違いの可能性があります。この検索結果の概要・PDF候補は採用していません。確認済みの情報と取り込み済みPDFは保持しています。</p>
    <details>
      <summary className="cursor-pointer">食い違った情報と確認先</summary>
      <dl className="mt-2 space-y-2 break-all">
        <div><dt className="text-muted-foreground">検索結果のタイトル</dt><dd>{failure.returned_title || "未取得"}</dd></div>
        {([["DOI", failure.expected_doi, failure.returned_doi], ["arXiv ID", failure.expected_arxiv_id, failure.returned_arxiv_id]] as const)
          .filter(([, expected, returned]) => expected || returned).map(([label, expected, returned]) => <div key={label}>
            <dt className="text-muted-foreground">元の文献の{label}</dt><dd>{expected || "未取得"}</dd>
            <dt className="text-muted-foreground mt-1">検索結果の{label}</dt><dd>{returned || "未取得"}</dd>
          </div>)}
      </dl>
      {!!failure.sources.length && <div className="mt-2 space-y-1">
        <p className="text-muted-foreground">採用していない検索結果の出典</p>
        {failure.sources.map((source, index) => <button key={`${index}:${source.url}`} className="block text-primary underline break-all text-left" onClick={() => openLink(source.url)}>{source.title}</button>)}
      </div>}
      <p className="mt-2 text-muted-foreground">確認日時：{new Date(failure.checked_at).toLocaleString()}</p>
    </details>
    <p className="leading-relaxed">文献リンクから元の文献を確認し、「情報を再取得」で再検索できます。</p>
  </div>;
}
