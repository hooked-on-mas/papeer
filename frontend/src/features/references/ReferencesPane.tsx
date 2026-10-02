import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, ChevronRight, ExternalLink, Network, RefreshCw } from "lucide-react";
import { api, unwrap } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { showError } from "@/components/errorDialog";
import { QK } from "@/lib/queryKeys";
import { useStore } from "@/store";
import { shell } from "@/shell";
import { navigateTo } from "@/features/reader/navigation";
import { citationIndex, graphPositions, graphView, publicationYear, relatedPapers, similarityPositions, similarityView, yearColor, type CitationGraph, type CitationNode, type Reference } from "./graph";
import { ResearchDetails } from "./ResearchDetails";
import { useResearch } from "./researchHooks";
import { openReferencePaper, referenceViews } from "./researchNavigation";
import { useAutomaticResearch } from "./autoResearch";
import { AutoResearchControl } from "./AutoResearchControl";

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

function graphLabel(title: string) {
  if (title.length <= 18) return [title];
  const space = title.lastIndexOf(" ", 18);
  const split = space > 7 ? space : 18;
  const rest = title.slice(split).trim();
  return [title.slice(0, split), rest.length > 18 ? rest.slice(0, 17) + "…" : rest];
}

export function ReferencesView({ graph, activePaperId, refreshing = false, refresh = () => {} }: {
  graph: CitationGraph; activePaperId: string | null; refreshing?: boolean; refresh?: () => void;
}) {
  const saved = activePaperId ? referenceViews.get(activePaperId) : undefined;
  const [trail, setTrail] = useState<string[]>(saved?.trail ?? []);
  const [chosenId, setSelectedId] = useState<string | null>(saved?.selectedId ?? activePaperId);
  const [chosenReferenceId, setReferenceId] = useState(saved?.referenceId);
  const [revealDetails, setRevealDetails] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(saved?.detailsOpen ?? false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const detailsElement = useRef<HTMLDivElement>(null);
  const lastReference = useRef(saved?.referenceId);
  const listElement = useRef<HTMLDivElement>(null);
  const listScroll = useRef(saved?.listScroll ?? 0);
  const graphElement = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<"nearby" | "library">(saved?.scope ?? (activePaperId ? "nearby" : "library"));
  const [external, setExternal] = useState(saved?.external ?? true);
  const [search, setSearch] = useState(saved?.search ?? "");
  const [listMode, setListMode] = useState<"references" | "incoming" | "related">(saved?.listMode ?? "references");
  const [sort, setSort] = useState<"original" | "newest" | "cited">(saved?.sort ?? "original");
  const [graphMode, setGraphMode] = useState<"citations" | "similarity">(saved?.graphMode ?? "citations");
  const [zoom, setZoom] = useState(saved?.zoom ?? 1);
  const center = trail[trail.length - 1] ?? activePaperId;
  const nodeMap = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const selectedId = chosenId && nodeMap.has(chosenId) ? chosenId
    : graph.references.find(r => r.id === lastReference.current)?.target ?? chosenId;
  const current = center ? nodeMap.get(center) : undefined;
  const selected = selectedId ? nodeMap.get(selectedId) : undefined;
  const related = useMemo(() => relatedPapers(graph, center), [graph, center]);
  const citationCounts = useMemo(() => citationIndex(graph).incoming, [graph]);
  const similar = useMemo(() => similarityView(graph, center, external), [graph, center, external]);
  const view = useMemo(() => graphMode === "similarity" ? similar : graphView(graph, center, scope, external), [graph, center, scope, external, graphMode, similar]);
  const positions = useMemo(() => graphMode === "similarity" ? similarityPositions(similar.nodes, center, similar.edges)
    : graphPositions(view.nodes, center), [view.nodes, center, graphMode, similar]);
  const nodeRadius = (node: CitationNode) => node.id === center ? 25 : 16 + Math.min(10, Math.sqrt(citationCounts.get(node.id)?.size ?? 0) * 3);
  const points = [...positions.values()];
  const left = Math.min(300, ...points.map((point) => point.x - 110));
  const top = Math.min(240, ...points.map((point) => point.y - 60));
  const width = Math.max(700, ...points.map((point) => point.x + 110)) - left;
  const height = Math.max(600, ...points.map((point) => point.y + 80)) - top;
  const markerId = useId().replace(/:/g, "");
  const references = graph.references.filter((ref) => ref.source === center);
  const incoming = graph.references.filter((ref) => ref.target === center && ref.source !== center);
  const rows = listMode === "related" ? related.map(item => ({ target: item.node, ref: undefined, relation: item }))
    : (listMode === "references" ? references : incoming).map(ref => ({ target: nodeMap.get(listMode === "incoming" ? ref.source : ref.target)!, ref, relation: undefined }));
  const shown = rows.filter(({ target, ref }) => `${target.title} ${ref?.raw ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => sort === "newest" ? (publicationYear(b.target.year) ?? 0) - (publicationYear(a.target.year) ?? 0)
      : sort === "cited" ? (citationCounts.get(b.target.id)?.size ?? 0) - (citationCounts.get(a.target.id)?.size ?? 0) : 0);
  const evidence = selected ? graph.references.filter((ref) => ref.target === selected.id && ref.source === center) : [];
  const selectedReference = graph.references.find(ref => ref.id === chosenReferenceId && ref.target === selectedId)
    ?? evidence[0] ?? graph.references.find(ref => ref.target === selectedId);
  const incomingReference = listMode === "incoming" ? incoming.find(ref => ref.source === selectedId) : undefined;
  const { data: researchRecords = [] } = useResearch(center);
  const automation = useAutomaticResearch(center, references, detailsOpen ? selectedReference?.research_key : undefined);
  const selectedRelation = related.find(item => item.node.id === selectedId);
  useEffect(() => {
    lastReference.current = selectedReference?.id;
    if (activePaperId) referenceViews.set(activePaperId, {
      ...referenceViews.get(activePaperId), trail, selectedId, scope, external, search, listMode, zoom,
      referenceId: selectedReference?.id, detailsOpen, sort, graphMode,
    });
  }, [activePaperId, trail, selectedId, selectedReference?.id, scope, external, search, listMode, zoom, detailsOpen, sort, graphMode]);
  useLayoutEffect(() => {
    if (graphElement.current) {
      graphElement.current.scrollTop = saved?.graphScroll?.top ?? 0;
      graphElement.current.scrollLeft = saved?.graphScroll?.left ?? 0;
    }
    // Restore only on mount; subsequent selections must not move the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    // A hidden list cannot restore its scroll offset until it is shown again.
    if (!detailsOpen && listElement.current) listElement.current.scrollTop = listScroll.current;
  }, [detailsOpen]);
  useLayoutEffect(() => {
    if (!revealDetails) return;
    detailsElement.current?.scrollIntoView({ block: "start", inline: "nearest" });
    detailsElement.current?.focus({ preventScroll: true });
  }, [revealDetails]);

  function selectNode(id: string) {
    setSelectedId(id); setReferenceId(undefined);
    setDetailsOpen(true);
    setRevealDetails(count => count + 1);
  }

  function showReference(ref: Reference) {
    setSelectedId(ref.target); setReferenceId(ref.id);
    setDetailsOpen(true);
    setRevealDetails(count => count + 1);
  }

  function explore(id: string) {
    if (id !== center) setTrail((old) => [...old, id]);
    selectNode(id);
    setDetailsOpen(false);
    setSearch("");
    setScope("nearby");
    setListMode("references");
    setGraphMode("citations");
  }

  function read(node: CitationNode) {
    if (!node.paper_id) return;
    openReferencePaper(activePaperId ?? center ?? node.paper_id, node.paper_id);
  }

  function source(ref: Reference) {
    useStore.getState().setActivePaperId(ref.source);
    navigateTo({ page: ref.page });
  }

  return <section className="@container flex flex-col flex-1 min-w-0 min-h-0" aria-label="参考文献と引用ネットワーク">
    <div className="px-5 py-3 border-b space-y-2 shrink-0">
      <div className="flex gap-3 items-center">
        <Network className="size-5 text-primary shrink-0" />
        <h2 className="font-semibold">参考文献</h2>
        <Button variant="outline" size="sm" className="ml-auto @[900px]:hidden" aria-expanded={networkOpen} onClick={() => setNetworkOpen(!networkOpen)}>引用関係</Button>
        <Button variant="ghost" size="sm" className="@[900px]:ml-auto" disabled={refreshing} onClick={refresh}>
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} /> 更新
        </Button>
      </div>
      {graph.warnings.length > 0 && <p className="text-xs text-amber-600" role="status">{graph.warnings.length}件の論文で本文を読み取れず、一部の関係を表示できません。{graph.warnings.map((w) => nodeMap.get(w.paper_id)?.title ?? w.paper_id).join("、")}</p>}
    </div>
    <AutoResearchControl state={automation} />
    <div className="flex-1 min-h-0 overflow-auto flex flex-col @[900px]:flex-row">
      <div className={`${networkOpen ? "flex" : "hidden"} flex-col @[900px]:flex @[900px]:w-[55%] @[900px]:min-h-0 border-b @[900px]:border-b-0 @[900px]:border-r`}>
        <div className="flex items-center flex-wrap gap-2 p-3">
          <Button size="sm" variant="outline" disabled={!trail.length} onClick={() => {
            const previous = trail.slice(0, -1);
            setTrail(previous); setSelectedId(previous[previous.length - 1] ?? activePaperId); setReferenceId(undefined); setSearch(""); setDetailsOpen(false);
          }}><ArrowLeft className="size-3.5" /> 戻る</Button>
          <select aria-label="グラフの種類" className="text-sm bg-background border rounded-md p-1.5" value={graphMode}
            onChange={event => {
              const mode = event.target.value as typeof graphMode;
              setGraphMode(mode); setListMode(mode === "similarity" ? "related" : "references");
            }}>
            <option value="citations">引用関係</option><option value="similarity">文献の類似性</option>
          </select>
          <select aria-label="ネットワークの範囲" disabled={graphMode === "similarity"} className="text-sm bg-background border rounded-md p-1.5 disabled:opacity-50" value={graphMode === "similarity" ? "nearby" : scope}
            onChange={(event) => setScope(event.target.value as typeof scope)}>
            <option value="nearby" disabled={!center}>この文献の周辺</option><option value="library">ライブラリ全体</option>
          </select>
          <label className="flex gap-1.5 items-center text-xs"><input type="checkbox" checked={external} onChange={(e) => setExternal(e.target.checked)} />未登録も表示</label>
          <label className="flex gap-1 items-center text-xs ml-auto">倍率<select aria-label="ネットワークの倍率" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="bg-background border rounded p-1">
            <option value={1}>100%</option><option value={1.5}>150%</option><option value={2}>200%</option>
          </select></label>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">古い<span className="inline-block h-2 w-14 rounded" style={{ background: "linear-gradient(to right, oklch(0.87 0.04 245), oklch(0.62 0.14 245))" }} />新しい</span>
          <span>大きさ：ライブラリ内の被引用数</span><span>点線：PDF未登録</span>
          {view.total > view.nodes.length && <span>{view.total}件中{view.nodes.length}件を表示</span>}
        </div>
        <div ref={graphElement} className="overflow-auto min-h-80 @[900px]:flex-1 bg-muted/20" onScroll={event => {
          const state = activePaperId && referenceViews.get(activePaperId);
          if (state) state.graphScroll = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft };
        }}>
          {view.nodes.length === 0 ? <p className="p-8 text-sm text-muted-foreground">PDFをライブラリに追加すると、ここに引用関係が表示されます。</p> :
          <svg viewBox={`${left} ${top} ${width} ${height}`} style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, minWidth: 300 * zoom, minHeight: 320 * zoom }} className="block" aria-label="引用関係の図">
            <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" /></marker></defs>
            {view.edges.map((edge) => {
              const a = positions.get(edge.source)!, b = positions.get(edge.target)!;
              const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
              const dx = (b.x - a.x) / distance, dy = (b.y - a.y) / distance;
              const highlighted = edge.source === selectedId || edge.target === selectedId;
              return <line key={`${edge.source}:${edge.target}`} x1={a.x + dx * nodeRadius(nodeMap.get(edge.source)!)} y1={a.y + dy * nodeRadius(nodeMap.get(edge.source)!)} x2={b.x - dx * (nodeRadius(nodeMap.get(edge.target)!) + 4)} y2={b.y - dy * (nodeRadius(nodeMap.get(edge.target)!) + 4)}
                className={highlighted ? "stroke-primary" : "stroke-muted-foreground"} strokeWidth={highlighted ? 2.5 : 1.2} opacity={highlighted ? 0.85 : 0.25} markerEnd={graphMode === "citations" ? `url(#${markerId})` : undefined} />;
            })}
            {view.nodes.map((node) => {
              const point = positions.get(node.id)!;
              return <g key={node.id} transform={`translate(${point.x},${point.y})`} role="button" tabIndex={0} aria-label={node.title}
                aria-pressed={selectedId === node.id} className="cursor-pointer outline-none group"
                onClick={() => selectNode(node.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectNode(node.id); } }}>
                <title>{node.title}{node.year ? ` (${node.year})` : ""}{node.paper_id ? "（登録済み）" : "（未登録）"} · ライブラリ内の被引用 {citationCounts.get(node.id)?.size ?? 0}件</title>
                <circle r={nodeRadius(node)} strokeWidth={selectedId === node.id ? 4 : 2}
                  strokeDasharray={node.paper_id ? undefined : "4 3"}
                  style={{ fill: node.id === center ? "var(--primary)" : yearColor(node.year, view.nodes) }}
                  className={`${node.id === center || node.paper_id ? "stroke-primary" : "stroke-muted-foreground"} group-focus:stroke-foreground`} />
                <text y={5} textAnchor="middle" fontSize="12" style={{ fill: node.id === center ? "var(--primary-foreground)" : publicationYear(node.year) ? "#172c43" : "var(--foreground)" }}>{node.year || "?"}</text>
                <text y={39} textAnchor="middle" fontSize="12" className={`fill-foreground ${view.nodes.length > 24 && selectedId !== node.id && node.id !== center ? "opacity-0 group-hover:opacity-100 group-focus:opacity-100" : ""}`} paintOrder="stroke" stroke="var(--background)" strokeWidth="4" strokeLinejoin="round">
                  {graphLabel(node.title).map((line, i) => <tspan key={i} x={0} dy={i ? 15 : 0}>{line}</tspan>)}
                </text>
              </g>;
            })}
          </svg>}
        </div>
        <p className="border-t p-3 text-xs text-muted-foreground">{graphMode === "similarity"
          ? "線は共通の参考文献・共引用を示します。関係が強い文献を近くに配置。ライブラリ内の引用情報に基づくため、分野全体の類似度ではありません。"
          : "矢印は「引用する論文 → 引用される文献」。ライブラリ内で確認できた引用関係を表示しています。"}</p>
      </div>
      <div className={`flex flex-col flex-1 min-w-0 @[900px]:w-[45%] ${networkOpen ? "min-h-96 @[900px]:min-h-0" : "min-h-0"}`}>
        {detailsOpen && selected ? <div ref={detailsElement} tabIndex={-1} className="overflow-auto p-5 space-y-5 outline-none" aria-label="選択した文献の詳細">
          <Button size="sm" variant="ghost" onClick={() => {
            setDetailsOpen(false);
            requestAnimationFrame(() => listElement.current?.querySelector<HTMLButtonElement>("button[aria-current=true]")?.focus({ preventScroll: true }));
          }}><ArrowLeft /> 一覧に戻る</Button>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{selected.year}{selected.year && " · "}{selected.paper_id ? "ライブラリに登録済み" : "未登録の文献"}</p>
            <h3 className="text-base font-semibold leading-relaxed break-words">{selected.title}</h3>
            {selectedRelation && <p className="text-xs text-muted-foreground">{selectedRelation.sharedReferences > 0 && `共通の参考文献 ${selectedRelation.sharedReferences}件`}{selectedRelation.sharedReferences > 0 && selectedRelation.sharedCitations > 0 && " · "}{selectedRelation.sharedCitations > 0 && `一緒に引用された論文 ${selectedRelation.sharedCitations}件`}</p>}
          </div>
          {selectedReference ? <ResearchDetails key={selectedReference.id} sourcePaperId={selectedReference.source} reference={selectedReference} registeredPaperId={selected.paper_id} />
            : selected.paper_id ? <Button onClick={() => read(selected)}><BookOpen /> PDFを読む</Button>
            : <Button onClick={() => openExternal(selected.url)}><ExternalLink /> 外部で探す</Button>}
          <div className="border-t pt-4 space-y-3">
            {incomingReference && <Button size="sm" variant="outline" onClick={() => source(incomingReference)}>この論文での引用箇所 p.{incomingReference.page}</Button>}
            {selectedReference && <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer py-1">書誌情報・引用元</summary>
              <div className="pt-3 space-y-3">
                <p className="break-words whitespace-pre-wrap leading-relaxed">{selectedReference.raw}</p>
                <p>{selectedReference.match === "title" ? "タイトルで照合しています。原文で確認してください。" : selectedReference.match === "identifier" ? "DOI・arXiv IDで照合済み" : selectedReference.match === "manual" ? "取り込んだPDFに関連付け済み" : "ライブラリのPDFとは未照合"}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => source(selectedReference)}>引用元 p.{selectedReference.page}</Button>
                  <Button size="sm" variant="outline" onClick={() => openExternal(selectedReference.url)}><ExternalLink />{selectedReference.doi ? "DOIを開く" : selectedReference.arxiv_id ? "arXivを開く" : "Scholarで探す"}</Button>
                </div>
              </div>
            </details>}
            <Button size="sm" variant="ghost" onClick={() => explore(selected.id)}><Network /> この文献からたどる</Button>
          </div>
        </div> : null}
        <div hidden={detailsOpen && !!selected} className="p-4 border-b space-y-3 shrink-0">
          {trail.length > 0 && <Button size="sm" variant="ghost" onClick={() => {
            const previous = trail.slice(0, -1);
            setTrail(previous); setSelectedId(previous[previous.length - 1] ?? activePaperId); setReferenceId(undefined); setSearch("");
          }}><ArrowLeft /> 前の文献に戻る</Button>}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">表示中の論文</p>
            <h3 className="text-sm font-medium break-words line-clamp-2" title={current?.title}>{current?.title ?? "論文を選ぶと参考文献を表示します"}</h3>
          </div>
          <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="group" aria-label="文献一覧の種類">
            <Button size="sm" className="flex-1" variant={listMode === "references" ? "outline" : "ghost"} aria-pressed={listMode === "references"} onClick={() => { setListMode("references"); setGraphMode("citations"); }}>参考文献 {references.length}</Button>
            <Button size="sm" className="flex-1" variant={listMode === "incoming" ? "outline" : "ghost"} aria-pressed={listMode === "incoming"} onClick={() => { setListMode("incoming"); setGraphMode("citations"); }}>この文献を引用 {incoming.length}</Button>
            <Button size="sm" className="flex-1" variant={listMode === "related" ? "outline" : "ghost"} aria-pressed={listMode === "related"} onClick={() => { setListMode("related"); setGraphMode("similarity"); }}>関連する論文 {related.length}</Button>
          </div>
          <Input aria-label="参考文献を検索" placeholder="タイトル・著者・DOIで検索" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{listMode === "related" ? "共通の参考文献・共引用から候補を表示" : "文献を選ぶと詳細を表示"}</span>
            <select aria-label="文献の並び順" className="bg-background border rounded p-1 max-w-40" value={sort} onChange={event => setSort(event.target.value as typeof sort)}>
              <option value="original">{listMode === "related" ? "関連が強い順" : "引用順"}</option><option value="newest">新しい順</option><option value="cited">ライブラリ内の被引用順</option>
            </select>
          </div>
        </div>
        <div hidden={detailsOpen && !!selected} ref={listElement} className="overflow-auto min-h-0 flex-1" onScroll={event => {
          if (event.currentTarget.hidden) return;
          listScroll.current = event.currentTarget.scrollTop;
          const state = activePaperId && referenceViews.get(activePaperId);
          if (state) state.listScroll = event.currentTarget.scrollTop;
        }}>
          {shown.length === 0 && <p className="text-sm text-muted-foreground p-5">{search ? "一致する文献はありません。" : listMode === "related" ? "共通の引用情報がある文献はまだありません。関連するPDFをライブラリに追加すると候補が増えます。" : listMode === "incoming" ? "ライブラリ内に、この文献への引用は見つかりませんでした。" : current?.paper_id ? "参考文献を抽出できませんでした。原文の参考文献欄をご確認ください。スキャンPDFはOCR後に更新してください。" : "登録済みの論文を選んでください。未登録の文献は、PDFを追加すると参考文献をたどれます。"}</p>}
          {shown.map(({ target, ref, relation }) => {
            const record = ref && listMode === "references" ? researchRecords.find(r => r.key === ref.research_key) : undefined;
            const chosen = ref && listMode === "references" ? selectedReference?.id === ref.id : selectedId === target.id;
            return <article key={ref?.id ?? target.id} className="border-b">
              <button aria-label={target.title} aria-current={chosen ? "true" : undefined}
                className={`w-full flex items-start gap-3 p-4 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 ${chosen ? "bg-primary/5" : ""}`}
                onClick={() => ref && listMode === "references" ? showReference(ref) : selectNode(target.id)}>
                {ref?.label && listMode === "references" && <span className="text-xs text-muted-foreground tabular-nums pt-1 shrink-0">{ref.label.padStart(2, "0")}</span>}
                <span className="min-w-0 flex-1 space-y-2">
                  <span className="block text-sm font-medium leading-relaxed break-words">{target.title}</span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {target.year && <span>{target.year}</span>}
                    <span className={`rounded px-1.5 py-0.5 ${target.paper_id || record?.paper_id ? "bg-primary/10 text-primary" : "bg-muted"}`}>{target.paper_id || record?.paper_id ? "PDFあり" : "PDF未登録"}</span>
                    {record?.has_summary ? <span>サマリーあり</span> : record && <span>調査済み</span>}
                    {ref && automation.active.some(item => item.source === ref.source && item.key === ref.research_key) && <span className="text-primary">AI収集中</span>}
                    {sort === "cited" && <span>被引用 {citationCounts.get(target.id)?.size ?? 0}件</span>}
                  </span>
                  {relation && <span className="block text-xs text-muted-foreground">{relation.sharedReferences > 0 ? `共通の参考文献 ${relation.sharedReferences}件` : `一緒に引用された論文 ${relation.sharedCitations}件`}</span>}
                </span>
                <ChevronRight className="size-4 text-muted-foreground shrink-0 mt-1" />
              </button>
            </article>;
          })}
          <p className="text-xs text-muted-foreground p-4 leading-relaxed">PDFから自動抽出しています。書誌情報や引用元は、文献を選んで確認できます。</p>
        </div>
      </div>
    </div>
  </section>;
}
