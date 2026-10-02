import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, ExternalLink, Network, RefreshCw } from "lucide-react";
import { api, unwrap } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { showError } from "@/components/errorDialog";
import { QK } from "@/lib/queryKeys";
import { useStore } from "@/store";
import { shell } from "@/shell";
import { navigateTo } from "@/features/reader/navigation";
import { graphPositions, graphView, type CitationGraph, type CitationNode, type Reference } from "./graph";

export function ReferencesPane() {
  const activePaperId = useStore((s) => s.activePaperId);
  const query = useQuery({
    queryKey: [QK.citations],
    queryFn: ({ signal }) => unwrap(api.GET("/api/citations", { signal })),
    staleTime: 30_000,
  });
  if (query.isPending) return <div className="p-6 text-muted-foreground" role="status">参考文献を読み取っています…</div>;
  if (query.isError) return <div className="p-6 space-y-3" role="alert">
    <p>参考文献を読み取れませんでした：{query.error.message}</p>
    <Button variant="outline" onClick={() => void query.refetch()}>再試行</Button>
  </div>;
  return <ReferencesView key={activePaperId ?? "library"} graph={query.data} activePaperId={activePaperId}
    refreshing={query.isFetching} refresh={() => void query.refetch()} />;
}

function openExternal(url: string) {
  void shell.openUrl(url).catch((error) => showError(error, "文献のリンクを開けませんでした"));
}

export function ReferencesView({ graph, activePaperId, refreshing = false, refresh = () => {} }: {
  graph: CitationGraph; activePaperId: string | null; refreshing?: boolean; refresh?: () => void;
}) {
  const [trail, setTrail] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(activePaperId);
  const [scope, setScope] = useState<"nearby" | "library">(activePaperId ? "nearby" : "library");
  const [external, setExternal] = useState(true);
  const [search, setSearch] = useState("");
  const [listMode, setListMode] = useState<"references" | "incoming">("references");
  const [zoom, setZoom] = useState(1);
  const center = trail[trail.length - 1] ?? activePaperId;
  const nodeMap = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const current = center ? nodeMap.get(center) : undefined;
  const selected = selectedId ? nodeMap.get(selectedId) : undefined;
  const view = useMemo(() => graphView(graph, center, scope, external), [graph, center, scope, external]);
  const positions = useMemo(() => graphPositions(view.nodes, center), [view.nodes, center]);
  const points = [...positions.values()];
  const left = Math.min(300, ...points.map((point) => point.x - 110));
  const top = Math.min(240, ...points.map((point) => point.y - 60));
  const width = Math.max(700, ...points.map((point) => point.x + 110)) - left;
  const height = Math.max(600, ...points.map((point) => point.y + 80)) - top;
  const markerId = useId().replace(/:/g, "");
  const references = graph.references.filter((ref) => ref.source === center);
  const incoming = graph.references.filter((ref) => ref.target === center && ref.source !== center);
  const shown = (listMode === "references" ? references : incoming).filter((ref) =>
    `${ref.raw} ${nodeMap.get(ref.source)?.title ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const evidence = selected ? graph.references.filter((ref) => ref.target === selected.id && ref.source === center) : [];

  function explore(id: string) {
    if (id !== center) setTrail((old) => [...old, id]);
    setSelectedId(id);
    setSearch("");
    setScope("nearby");
    setListMode("references");
  }

  function read(node: CitationNode) {
    if (!node.paper_id) return;
    const store = useStore.getState();
    store.setActivePaperId(node.paper_id);
    store.setActiveTab("reader");
  }

  function source(ref: Reference) {
    useStore.getState().setActivePaperId(ref.source);
    navigateTo({ page: ref.page });
  }

  return <section className="flex flex-col flex-1 min-w-0 min-h-0" aria-label="参考文献と引用ネットワーク">
    <div className="px-5 py-3 border-b space-y-2 shrink-0">
      <div className="flex gap-3 items-center">
        <Network className="size-5 text-primary shrink-0" />
        <h2 className="font-semibold">参考文献・引用ネットワーク</h2>
        <Button variant="ghost" size="sm" className="ml-auto" disabled={refreshing} onClick={refresh}>
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} /> 更新
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">保存済みPDFの参考文献から抽出。矢印は「引用する論文 → 引用される文献」です。被引用はライブラリ内で確認できたものだけです。</p>
      {graph.warnings.length > 0 && <p className="text-xs text-amber-600" role="status">{graph.warnings.length}件の論文で本文を読み取れず、一部の関係を表示できません。{graph.warnings.map((w) => nodeMap.get(w.paper_id)?.title ?? w.paper_id).join("、")}</p>}
    </div>
    <div className="flex-1 min-h-0 overflow-auto flex flex-col xl:flex-row">
      <div className="flex flex-col xl:w-[58%] xl:min-h-0 border-b xl:border-b-0 xl:border-r">
        <div className="flex items-center flex-wrap gap-2 p-3">
          <Button size="sm" variant="outline" disabled={!trail.length} onClick={() => {
            const previous = trail.slice(0, -1);
            setTrail(previous); setSelectedId(previous[previous.length - 1] ?? activePaperId); setSearch("");
          }}><ArrowLeft className="size-3.5" /> 戻る</Button>
          <select aria-label="ネットワークの範囲" className="text-sm bg-background border rounded-md p-1.5" value={scope}
            onChange={(event) => setScope(event.target.value as typeof scope)}>
            <option value="nearby" disabled={!center}>この文献の周辺</option><option value="library">ライブラリ全体</option>
          </select>
          <label className="flex gap-1.5 items-center text-xs"><input type="checkbox" checked={external} onChange={(e) => setExternal(e.target.checked)} />未登録も表示</label>
          <label className="flex gap-1 items-center text-xs ml-auto">倍率<select aria-label="ネットワークの倍率" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="bg-background border rounded p-1">
            <option value={1}>100%</option><option value={1.5}>150%</option><option value={2}>200%</option>
          </select></label>
        </div>
        <p className="text-xs px-3 pb-2 text-muted-foreground">青：登録済み　点線：未登録　・クリックで詳細{view.total > view.nodes.length && `（${view.total}件中${view.nodes.length}件を表示。文献を選び「この文献からたどる」で絞り込めます）`}</p>
        <div className="overflow-auto min-h-80 xl:flex-1 bg-muted/20">
          {view.nodes.length === 0 ? <p className="p-8 text-sm text-muted-foreground">PDFをライブラリに追加すると、ここに引用関係が表示されます。</p> :
          <svg viewBox={`${left} ${top} ${width} ${height}`} style={{ width: `${zoom * 100}%`, minWidth: 500 * zoom }} className="min-h-80" aria-label="引用関係の図">
            <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" /></marker></defs>
            {view.edges.map((edge) => {
              const a = positions.get(edge.source)!, b = positions.get(edge.target)!;
              const distance = Math.hypot(b.x - a.x, b.y - a.y);
              const dx = (b.x - a.x) / distance, dy = (b.y - a.y) / distance;
              const highlighted = edge.source === selectedId || edge.target === selectedId;
              return <line key={`${edge.source}:${edge.target}`} x1={a.x + dx * 18} y1={a.y + dy * 18} x2={b.x - dx * 22} y2={b.y - dy * 22}
                className={highlighted ? "stroke-primary" : "stroke-muted-foreground"} strokeWidth={highlighted ? 2.5 : 1.2} opacity={highlighted ? 0.85 : 0.25} markerEnd={`url(#${markerId})`} />;
            })}
            {view.nodes.map((node) => {
              const point = positions.get(node.id)!;
              return <g key={node.id} transform={`translate(${point.x},${point.y})`} role="button" tabIndex={0} aria-label={node.title}
                aria-pressed={selectedId === node.id} className="cursor-pointer outline-none group"
                onClick={() => setSelectedId(node.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(node.id); } }}>
                <title>{node.title}{node.year ? ` (${node.year})` : ""}{node.paper_id ? "（登録済み）" : "（未登録）"}</title>
                <circle r={node.id === center ? 23 : 17} strokeWidth={selectedId === node.id ? 4 : 2}
                  strokeDasharray={node.paper_id ? undefined : "4 3"}
                  className={`${node.id === center ? "fill-primary stroke-primary" : node.paper_id ? "fill-background stroke-primary" : "fill-background stroke-muted-foreground"} group-focus:stroke-foreground`} />
                <text y={5} textAnchor="middle" fontSize="12" className={node.id === center ? "fill-primary-foreground" : "fill-foreground"}>{node.year || "•"}</text>
                <text y={39} textAnchor="middle" fontSize="12" className="fill-foreground" paintOrder="stroke" stroke="var(--background)" strokeWidth="4" strokeLinejoin="round">
                  {node.title.length > 26 ? node.title.slice(0, 25) + "…" : node.title}
                </text>
              </g>;
            })}
          </svg>}
        </div>
        {selected && <div className="p-4 border-t space-y-2 bg-background">
          <p className="font-medium text-sm break-words">{selected.title}</p>
          <p className="text-xs text-muted-foreground">{selected.paper_id ? "ライブラリに登録済み" : "未登録・この文献自身の参考文献は未取得"}
            {evidence.some((ref) => ref.match === "title") && " · タイトル照合（原文で確認してください）"}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => explore(selected.id)}>この文献からたどる</Button>
            {selected.paper_id ? <Button size="sm" onClick={() => read(selected)}><BookOpen className="size-3.5" /> PDFを読む</Button>
              : <Button size="sm" variant="outline" onClick={() => openExternal(selected.url)}><ExternalLink className="size-3.5" /> 外部で探す</Button>}
          </div>
          {evidence.map((ref) => <p key={ref.id} className="text-xs text-muted-foreground line-clamp-3">{ref.raw}</p>)}
        </div>}
      </div>
      <div className="flex flex-col xl:w-[42%] min-w-0 xl:min-h-0">
        <div className="p-4 border-b space-y-3">
          <h3 className="text-sm font-medium break-words">{current?.title ?? "論文を選ぶと参考文献を表示します"}</h3>
          <div className="flex gap-2">
            <Button size="sm" variant={listMode === "references" ? "default" : "outline"} onClick={() => setListMode("references")}>参考文献 {references.length}</Button>
            <Button size="sm" variant={listMode === "incoming" ? "default" : "outline"} onClick={() => setListMode("incoming")}>この文献を引用 {incoming.length}</Button>
          </div>
          <Input aria-label="参考文献を検索" placeholder="タイトル・著者・DOIで絞り込み" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="xl:overflow-auto p-4 space-y-3">
          {shown.length === 0 && <p className="text-sm text-muted-foreground py-4">{search ? "一致する文献はありません。" : listMode === "incoming" ? "ライブラリ内に、この文献への引用は見つかりませんでした。" : current?.paper_id ? "参考文献を抽出できませんでした。原文の参考文献欄をご確認ください。スキャンPDFはOCR後に更新してください。" : "登録済みの論文を選んでください。未登録の文献は、PDFを追加すると参考文献をたどれます。"}</p>}
          {shown.map((ref) => {
            const target = nodeMap.get(listMode === "incoming" ? ref.source : ref.target)!;
            return <article key={ref.id} className={`rounded-lg border p-3 space-y-2 ${selectedId === target.id ? "border-primary bg-primary/5" : ""}`}>
              <div className="flex items-start gap-2">
                {ref.label && <span className="text-xs text-muted-foreground shrink-0">[{ref.label}]</span>}
                <button className="text-left text-sm font-medium hover:underline break-words" onClick={() => setSelectedId(target.id)}>{target.title}</button>
              </div>
              <p className="text-xs text-muted-foreground">{target.paper_id ? "登録済み" : "未登録"} · {ref.match === "identifier" ? "識別子で照合" : ref.match === "title" ? "タイトルで照合（要確認）" : "未照合"}</p>
              <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">抽出した原文</summary><p className="pt-2 break-words whitespace-pre-wrap">{ref.raw}</p></details>
              <div className="flex flex-wrap gap-x-3 gap-y-2 text-xs">
                <button className="text-primary hover:underline" onClick={() => explore(target.id)}>この文献からたどる</button>
                {target.paper_id && <button className="text-primary hover:underline" onClick={() => read(target)}>PDFを読む</button>}
                <button className="text-primary hover:underline" onClick={() => source(ref)}>引用元 p.{ref.page}</button>
                <button className="text-primary hover:underline" onClick={() => openExternal(ref.url)}>{ref.doi ? "DOIを開く" : ref.arxiv_id ? "arXivを開く" : "Scholarで探す"} ↗</button>
              </div>
            </article>;
          })}
          <p className="text-xs text-muted-foreground pt-2">文献の区切りやタイトルは自動抽出のため、原文と異なる場合があります。登録済み論文の情報は「メモ・整理」で修正できます。</p>
        </div>
      </div>
    </div>
  </section>;
}
