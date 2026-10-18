import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { useEffect, useRef, useState } from "react";
import { authorizedUrl } from "@/api/client";
import { followCitation } from "@/app/actions";
import { normalizeMarkdown } from "@/lib/normalizeMarkdown";
import { emitAppEvent } from "@/lib/appEvents";
import { CITATION_URL, documentCitation, markdownUrlTransform, mediaRequestPath } from "@/lib/markdownUrl";
import { openDocument } from "@/features/documents/documentState";

interface Props {
  content: string;
  className?: string;
  /** Paper whose media/ folder relative image paths refer to. */
  paperId?: string | null;
  /** Defaults to opening the cited page in the reader. */
  onCitationClick?: (page: number, paperId?: string) => void;
  /** Drop horizontal rules, which generated summaries overuse between sections. */
  dropRules?: boolean;
}

function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgContent, setSvgContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    import("mermaid").then((mermaid) => {
      // The chart comes from AI output, which a PDF can steer, so keep Mermaid's sanitizing mode.
      mermaid.default.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
      mermaid.default.render("mermaid-" + Math.random().toString(36).substring(7), chart).then((result) => {
        if (!isMounted) return;
        setSvgContent(result.svg);
        setError(null);
      }).catch(err => {
        if (!isMounted) return;
        // The message quotes the chart source, so it is rendered as text, never as HTML.
        setSvgContent("");
        setError(err instanceof Error ? err.message : String(err));
      });
    });
    return () => { isMounted = false; };
  }, [chart]);

  if (error !== null) {
    return <div className="my-4 text-red-500 whitespace-pre-wrap break-words">{error}</div>;
  }
  return <div ref={containerRef} dangerouslySetInnerHTML={{ __html: svgContent }} className="flex justify-center my-4" />;
}

export function MarkdownRenderer({ content, className, paperId, onCitationClick, dropRules }: Props) {
  const cite = onCitationClick ?? ((page: number, id?: string) => {
    const target = id || paperId || useStore.getState().activePaperId;
    if (target) followCitation(target, page);
  });
  const normalizedContent = normalizeMarkdown(content, { dropRules });

  return (
    <div className={cn("prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={markdownUrlTransform}
        components={{
          a: ({ node, ...props }) => {
            const href = props.href || "";
            // An HTML document the chat read: it opens that saved document, not a page of the paper.
            const documentMatch = documentCitation(href);
            if (documentMatch) {
              return (
                <button
                  type="button"
                  title="資料（HTML）を開く"
                  onClick={() => openDocument(documentMatch.owner, documentMatch.document)}
                  className="citation-link inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 text-[0.75rem] font-semibold leading-normal text-primary bg-primary/10 hover:bg-primary/20 rounded cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {props.children}
                </button>
              );
            }
            const papeerMatch = href.match(CITATION_URL);
            if (papeerMatch) {
              const paperId = papeerMatch[1];
              const page = Number(papeerMatch[2]);
              return (
                <button 
                  type="button"
                  title={`原文の${page}ページを開く`}
                  aria-label={`原文の${page}ページを開く`}
                  onClick={() => cite(page, paperId)}
                  className="citation-link inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 text-[0.75rem] font-semibold leading-normal text-primary bg-primary/10 hover:bg-primary/20 rounded cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {props.children || page}
                </button>
              );
            }
            
            const match = props.children?.toString().match(/^\[(\d+)\]$/);
            if (match) {
              return (
                <button 
                  type="button"
                  title={`原文の${match[1]}ページを開く`}
                  onClick={() => cite(Number(match[1]))}
                  className="citation-link inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 text-[0.75rem] font-semibold leading-normal text-primary bg-primary/10 hover:bg-primary/20 rounded cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {match[1]}
                </button>
              );
            }
            // A link whose URL markdownUrlTransform refused (file:, javascript: ...) stays as its text.
            if (!href) return <span>{props.children}</span>;
            return <a {...props} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer" />;
          },
          pre: ({ node, ...props }) => (
            <pre className="bg-muted p-3 rounded-md overflow-x-auto text-[0.8125rem]" {...props} />
          ),
          code: ({ node, className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || "");
            if (match && match[1] === "mermaid") {
              return <MermaidDiagram chart={String(children).replace(/\n$/, "")} />;
            }
            return <code className={cn("bg-muted px-1 py-0.5 rounded text-[0.8125rem]", className)} {...props}>{children}</code>;
          },
          img: ({ node, ...props }) => {
            // markdownUrlTransform has already turned a media image's file:// URI into its sidecar path
            // and dropped every other file: URL; only media paths get the token.
            let src = props.src || "";
            const media = mediaRequestPath(src, paperId || useStore.getState().activePaperId);
            if (media) src = authorizedUrl(media);
            return <img {...props} src={src} className="max-w-full h-auto rounded-md shadow-sm my-4 cursor-zoom-in" loading="lazy"
              onClick={() => emitAppEvent("open-lightbox", { src, alt: props.alt })} />;
          }
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}
