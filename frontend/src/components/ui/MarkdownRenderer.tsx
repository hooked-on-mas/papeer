import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "@/lib/utils";

interface Props {
  content: string;
  className?: string;
  onCitationClick?: (index: number) => void;
}

export function MarkdownRenderer({ content, className, onCitationClick }: Props) {
  return (
    <div className={cn("prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        components={{
          a: ({ node, ...props }) => {
            const match = props.children?.toString().match(/^\[(\d+)\]$/);
            if (match && onCitationClick) {
              return (
                <button 
                  onClick={() => onCitationClick(Number(match[1]))}
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
          code: ({ node, ...props }) => (
            <code className="bg-muted px-1 py-0.5 rounded text-[13px]" {...props} />
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
