import { MarkdownContent } from "./MarkdownContent";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { authorizedUrl } from "@/api/client";
import { followCitation } from "@/app/actions";
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

export function MarkdownRenderer({ content, className, paperId, onCitationClick, dropRules }: Props) {
  const cite = onCitationClick ?? ((page: number, id?: string) => {
    const target = id || paperId || useStore.getState().activePaperId;
    if (target) followCitation(target, page);
  });

  return (
    <div className={cn("prose prose-sm dark:prose-invert max-w-none", className)}>
      <MarkdownContent content={content} dropRules={dropRules}
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
      />
    </div>
  );
}
