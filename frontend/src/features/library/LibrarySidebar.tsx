import { useState } from "react";
import { DndContext, DragEndEvent, useDraggable, useDroppable, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Folder, FilePlus2, Search, ArrowUpDown, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "@/api/client";
import { useStore } from "@/store";
import { shell } from "@/shell";

type Paper = {
  id: string;
  title: string;
  first_author?: string;
  publication_year?: string;
  collection_name?: string;
  note?: string;
  has_article?: boolean;
};

export function LibrarySidebar() {
  const queryClient = useQueryClient();
  const activePaperId = useStore((state) => state.activePaperId);
  const setActivePaperId = useStore((state) => state.setActivePaperId);

  const { data: papers = [] } = useQuery({
    queryKey: ["papers"],
    queryFn: () => api.GET("/api/papers").then((res) => (res.data as unknown as Paper[]) || []),
  });

  const { data: collections = [] } = useQuery({
    queryKey: ["collections"],
    queryFn: () => api.GET("/api/collections").then((res) => res.data || []),
  });

  const updatePaperMutation = useMutation({
    mutationFn: ({ paperId, collection }: { paperId: string; collection: string }) =>
      api.PATCH("/api/papers/{paper_id}", {
        params: { path: { paper_id: paperId } },
        body: { collection },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const paperId = active.id as string;
    let targetCollection = over.id as string;
    if (targetCollection === "unfiled") {
      targetCollection = "";
    }
    const paper = papers.find((p) => p.id === paperId);
    if (paper && paper.collection_name !== targetCollection) {
      updatePaperMutation.mutate({ paperId, collection: targetCollection });
    }
  };

  const handleAddPdf = async () => {
    try {
      const paths = await shell.openFiles([{ name: "PDF Files", extensions: ["pdf"] }]);
      if (paths.length > 0) {
        const res = await api.POST("/api/papers/import", {
          body: { paths }
        });
        if (res.error) {
          console.error("Failed to import papers", res.error);
        } else {
          queryClient.invalidateQueries({ queryKey: ["papers"] });
        }
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".pdf";
        input.multiple = true;
        input.onchange = async (e) => {
          const files = (e.target as HTMLInputElement).files;
          if (!files || files.length === 0) return;
          
          for (let i = 0; i < files.length; i++) {
            const formData = new FormData();
            formData.append("file", files[i]);
            try {
              const port = import.meta.env.VITE_PAPERDESK_PORT || 8000;
              const token = import.meta.env.VITE_PAPERDESK_TOKEN || "";
              await fetch(`http://127.0.0.1:${port}/api/papers/upload`, {
                method: "POST",
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                body: formData
              });
            } catch (err) {
              console.error("Failed to upload file", err);
            }
          }
          queryClient.invalidateQueries({ queryKey: ["papers"] });
        };
        input.click();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const papersByCollection = collections.reduce((acc, col) => {
    acc[col] = papers.filter((p) => p.collection_name === col);
    return acc;
  }, {} as Record<string, Paper[]>);

  const unfiledPapers = papers.filter((p) => !p.collection_name || !collections.includes(p.collection_name));

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 5 } });
  const sensors = useSensors(pointerSensor);

  return (
    <div className="flex flex-col h-full text-[13px]">
      <div className="p-2 space-y-2 shrink-0">
        <button 
          onClick={handleAddPdf}
          className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground h-[32px] rounded-md font-medium hover:opacity-90 transition-opacity"
        >
          <FilePlus2 className="w-4 h-4" />
          ＋ PDF を追加
        </button>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input 
            type="text" 
            placeholder="タイトル・著者で検索" 
            className="w-full h-[32px] pl-8 pr-8 rounded-md bg-background border text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <ArrowUpDown className="w-4 h-4" />
          </button>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-auto py-1">
          {collections.map((col) => (
            <DroppableCollection
              key={col}
              id={col}
              name={col}
              papers={papersByCollection[col] || []}
              activePaperId={activePaperId}
              onSelect={setActivePaperId}
            />
          ))}
          
          <DroppableCollection
            id="unfiled"
            name="未分類"
            papers={unfiledPapers}
            activePaperId={activePaperId}
            onSelect={setActivePaperId}
          />

          {papers.length === 0 && (
            <div className="px-4 py-8 text-center text-muted-foreground">
              <p>論文がありません。</p>
              <p className="mt-1">「PDF を追加」か、ここにファイルをドロップ</p>
            </div>
          )}
        </div>
      </DndContext>
    </div>
  );
}

function DroppableCollection({
  id,
  name,
  papers,
  activePaperId,
  onSelect,
}: {
  id: string;
  name: string;
  papers: Paper[];
  activePaperId: string | null;
  onSelect: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div ref={setNodeRef} className={isOver ? "ring-2 ring-primary ring-inset rounded" : ""}>
      <div 
        className="flex items-center px-2 h-[32px] cursor-pointer hover:bg-muted/50 group"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="w-4 h-4 flex items-center justify-center mr-1 text-muted-foreground">
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>
        <Folder className="mr-2 h-4 w-4 text-muted-foreground" />
        <span className="flex-1 truncate">{name}</span>
        <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">{papers.length}</span>
      </div>
      
      {isExpanded && papers.length > 0 && (
        <div className="ml-5">
          {papers.map((paper) => (
            <DraggablePaper
              key={paper.id}
              paper={paper}
              isActive={paper.id === activePaperId}
              onSelect={() => onSelect(paper.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DraggablePaper({
  paper,
  isActive,
  onSelect,
}: {
  paper: Paper;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: paper.id,
  });

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50, opacity: 0.8 }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <div 
        onClick={onSelect} 
        className={`flex flex-col justify-center min-h-[32px] px-2 cursor-pointer group ${
          isActive ? "bg-accent border-l-2 border-primary pl-[6px]" : "hover:bg-muted/50 border-l-2 border-transparent pl-[6px]"
        }`}
      >
        <div className="flex items-center">
          <FileText className="h-4 w-4 mr-2 text-muted-foreground shrink-0" />
          <span className="truncate flex-1" title={paper.title}>{paper.title}</span>
          {/* status dot */}
          {paper.has_article && <span className="w-2 h-2 rounded-full bg-success ml-2 shrink-0"></span>}
        </div>
        {/* Author / Year can go here on hover or always */}
      </div>
    </div>
  );
}
