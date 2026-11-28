import { useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMarkdown } from "../../lib/normalizeMarkdown";

/** Shared Markdown rendering. Resource loading and application navigation belong to the caller. */
export function MarkdownContent({ content, components, urlTransform = safeMarkdownUrl, dropRules }: {
  content: string;
  components?: Components;
  urlTransform?: UrlTransform;
  dropRules?: boolean;
}) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}
    urlTransform={urlTransform} components={{ ...sharedComponents, ...components }}>
    {normalizeMarkdown(content, { dropRules })}
  </ReactMarkdown>;
}

function safeMarkdownUrl(url: string) {
  return /^[\\/]{2}/.test(url) ? "" : defaultUrlTransform(url);
}

const sharedComponents: Components = {
  a: ({ href, children }) => href ? <a href={href} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  pre: ({ children }) => <pre className="bg-muted p-3 rounded-md overflow-x-auto text-[0.8125rem]">{children}</pre>,
  code: ({ className, children }) => /language-mermaid\b/.test(className ?? "")
    ? <MermaidDiagram chart={String(children).replace(/\n$/, "")} />
    : <code className={`bg-muted px-1 py-0.5 rounded text-[0.8125rem] ${className ?? ""}`}>{children}</code>,
};

function MermaidDiagram({ chart }: { chart: string }) {
  const [result, setResult] = useState<{ chart: string; svg?: string; error?: string }>();
  useEffect(() => {
    let alive = true;
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
      const { svg } = await mermaid.render(`mermaid-${crypto.randomUUID()}`, chart);
      if (alive) setResult({ chart, svg });
    }).catch(error => { if (alive) setResult({ chart, error: error instanceof Error ? error.message : String(error) }); });
    return () => { alive = false; };
  }, [chart]);
  if (result?.chart !== chart) return null;
  if (result.error) return <div className="my-4 text-red-500 whitespace-pre-wrap break-words">{result.error}</div>;
  return <div dangerouslySetInnerHTML={{ __html: result.svg ?? "" }} className="flex justify-center my-4" />;
}
