import { useState } from "react";
import { DndContext, DragEndEvent, useDraggable, useDroppable, closestCenter } from "@dnd-kit/core";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Folder, GripVertical } from "lucide-react";
import { api } from "@/api/client";
import { useStore } from "@/store";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroupContent,
} from "@/components/ui/sidebar";

type Paper = {
  id: string;
  title: string;
  first_author?: string;
  publication_year?: string;
  collection_name?: string;
  note?: string;
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

  // Group papers by collection
  const papersByCollection = collections.reduce((acc, col) => {
    acc[col] = papers.filter((p) => p.collection_name === col);
    return acc;
  }, {} as Record<string, Paper[]>);

  const unfiledPapers = papers.filter((p) => !p.collection_name || !collections.includes(p.collection_name));

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SidebarGroup>
        <SidebarGroupLabel>Library</SidebarGroupLabel>
        <SidebarGroupContent>
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
            name="Unfiled"
            papers={unfiledPapers}
            activePaperId={activePaperId}
            onSelect={setActivePaperId}
          />
        </SidebarGroupContent>
      </SidebarGroup>
    </DndContext>
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
    <div ref={setNodeRef} className={isOver ? "bg-accent/50 rounded-md" : ""}>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={() => setIsExpanded(!isExpanded)} className="font-semibold cursor-pointer select-none">
            <Folder className="mr-2 h-4 w-4" />
            <span>{name}</span>
          </SidebarMenuButton>
          {isExpanded && papers.length > 0 && (
            <div className="ml-4 pl-2 border-l">
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
        </SidebarMenuItem>
      </SidebarMenu>
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
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 }
    : undefined;

  return (
    <div ref={setNodeRef} style={style}>
      <SidebarMenuButton 
        isActive={isActive} 
        onClick={onSelect} 
        className="cursor-pointer group flex items-center h-8"
      >
        <div {...listeners} {...attributes} className="cursor-grab opacity-0 group-hover:opacity-100 transition-opacity">
          <GripVertical className="h-4 w-4 mr-1 text-muted-foreground" />
        </div>
        <FileText className="h-4 w-4 mr-2" />
        <span className="truncate flex-1" title={paper.title}>{paper.title}</span>
      </SidebarMenuButton>
    </div>
  );
}
