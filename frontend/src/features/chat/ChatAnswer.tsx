import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { splitChatReferences } from "./chatReferences";

export function ChatAnswer({ content, paperId }: { content: string; paperId: string }) {
  const { answer, note, label } = splitChatReferences(content);
  return <>
    <MarkdownRenderer content={answer} paperId={paperId} className="max-w-none" />
    {note && <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{label}</summary>
      <div className="mt-2 max-h-48 overflow-y-auto rounded border bg-muted/30 px-3 py-2">
        <MarkdownRenderer content={note} paperId={paperId} className="text-xs [&_p]:my-0" />
      </div>
    </details>}
  </>;
}
