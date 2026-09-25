import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { useEffect, useRef, useState } from "react";
import { authorizedUrl } from "@/api/client";
import { followCitation } from "@/app/actions";

interface Props {
  content: string;
  className?: string;
  /** Paper whose media/ folder relative image paths refer to. */
  paperId?: string | null;
  /** Defaults to opening the cited page in the reader. */
  onCitationClick?: (page: number, paperId?: string) => void;
}

function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgContent, setSvgContent] = useState<string>("");

  useEffect(() => {
    let isMounted = true;
    import("mermaid").then((mermaid) => {
      mermaid.default.initialize({ startOnLoad: false, theme: "neutral" });
      mermaid.default.render("mermaid-" + Math.random().toString(36).substring(7), chart).then((result) => {
        if (isMounted) setSvgContent(result.svg);
      }).catch(err => {
        if (isMounted) setSvgContent(`<pre class="text-red-500">${err.message}</pre>`);
      });
    });
    return () => { isMounted = false; };
  }, [chart]);

  return <div ref={containerRef} dangerouslySetInnerHTML={{ __html: svgContent }} className="flex justify-center my-4" />;
}

export function MarkdownRenderer({ content, className, paperId, onCitationClick }: Props) {
  const cite = onCitationClick ?? ((page: number, id?: string) => {
    const target = id || paperId || useStore.getState().activePaperId;
    if (target) followCitation(target, page);
  });
  const normalizedContent = content
    .replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$')
    .replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$');

  return (
    <div className={cn("prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={(value) => {
          if (value.startsWith("paperdesk:") || value.startsWith("file:")) return value;
          return defaultUrlTransform(value);
        }}
        components={{
          a: ({ node, ...props }) => {
            const href = props.href || "";
            const paperdeskMatch = href.match(/^paperdesk:\/\/([^/]+)\/(\d+)$/);
            if (paperdeskMatch) {
              const paperId = paperdeskMatch[1];
              const page = Number(paperdeskMatch[2]);
              return (
                <button 
                  onClick={() => cite(page, paperId)}
                  className="inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 text-[10px] font-bold text-primary bg-primary/10 hover:bg-primary/20 rounded cursor-pointer transition-colors"
                >
                  {props.children || page}
                </button>
              );
            }
            
            const match = props.children?.toString().match(/^\[(\d+)\]$/);
            if (match) {
              return (
                <button 
                  onClick={() => cite(Number(match[1]))}
                  className="inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 text-[10px] font-bold text-primary bg-primary/10 hover:bg-primary/20 rounded cursor-pointer transition-colors"
                >
                  {match[1]}
                </button>
              );
            }
            return <a {...props} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer" />;
          },
          pre: ({ node, ...props }) => (
            <pre className="bg-muted p-3 rounded-md overflow-x-auto text-[13px]" {...props} />
          ),
          code: ({ node, className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || "");
            if (match && match[1] === "mermaid") {
              return <MermaidDiagram chart={String(children).replace(/\n$/, "")} />;
            }
            return <code className={cn("bg-muted px-1 py-0.5 rounded text-[13px]", className)} {...props}>{children}</code>;
          },
          img: ({ node, ...props }) => {
            let src = props.src || "";
            // Older article.md files embed absolute file:// URIs of papers/<id>/media/<name>.
            const fileMatch = src.match(/papers\/([0-9a-f]{32})\/media\/([^/?#]+)$/);
            const owner = paperId || useStore.getState().activePaperId;
            if (fileMatch) {
              src = authorizedUrl(`/api/papers/${fileMatch[1]}/media/${fileMatch[2]}`);
            } else if (src.startsWith("media/") && owner) {
              src = authorizedUrl(`/api/papers/${owner}/${src}`);
            }
            return <img {...props} src={src} className="max-w-full h-auto rounded-md shadow-sm my-4 cursor-zoom-in" loading="lazy"
              onClick={() => window.dispatchEvent(new CustomEvent("open-lightbox", { detail: { src, alt: props.alt } }))} />;
          }
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}
