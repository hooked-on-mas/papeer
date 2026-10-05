import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Network, RefreshCw } from "lucide-react";
import { api, unwrap } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QK } from "@/lib/queryKeys";
import { useStore } from "@/store";
import { navigateTo } from "@/features/reader/navigation";
import type { CitationGraph } from "./graph";
import { MapNetwork } from "./MapNetwork";
import { mapGroups, citationScope, reconcileMapLayout } from "./mapLayout";
import { MapTimings, type LayoutTiming } from "./MapTimings";
import { ResearchDetails } from "./ResearchDetails";
import { useResearch } from "./researchHooks";
import { useAutomaticResearch } from "./autoResearch";
import { AutoResearchControl } from "./AutoResearchControl";
import { useDiscovery } from "./discoveryHooks";
import { discoveryDiagnostics } from "./discoveryDiagnostics";
import { useGroupDescriptions } from "./groupHooks";
import { externalCitationSource, externalCitationSources, localMap, mapRows, mapWindow, mapPositions, mapViews, newView, type MapMode, type MapNode, type SavedMapView } from "./mapGraph";
import { openReferencePaper } from "./researchNavigation";

const MODES: [MapMode, string][] = [["nearby", "周辺の論文"], ["references", "直接の参考文献"], ["incoming", "この論文を引用"],
  ["related", "近い論文"], ["prior", "先行研究"], ["following", "後続研究"]];

export function ReferencesPane() {
  const activePaperId = useStore(s => s.activePaperId);
  const query = useQuery({ queryKey: [QK.citations], queryFn: ({ signal }) => unwrap(api.GET("/api/citations", { signal })), staleTime: 30_000 });
  if (query.isPending) return <div className="p-6 text-muted-foreground" role="status">論文マップを読み込んでいます…</div>;
  if (query.isError) return <div className="p-6 space-y-3" role="alert"><p>論文マップを読み込めませんでした：{query.error.message}</p><Button variant="outline" onClick={() => void query.refetch()}>再試行</Button></div>;
  return <ReferencesView key={activePaperId ?? "library"} graph={query.data} activePaperId={activePaperId} />;
}

export function ReferencesView({ graph, activePaperId }: { graph: CitationGraph; activePaperId: string | null; refreshing?: boolean; refresh?: () => void }) {
  const saved = activePaperId ? mapViews.get(activePaperId) : undefined;
  const [view, setView] = useState<SavedMapView>(saved?.view ?? newView(activePaperId ?? graph.nodes[0]?.id ?? ""));
  const [trail, setTrail] = useState<SavedMapView[]>(saved?.trail ?? []);
  const [hover, setHover] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [layoutTiming, setLayoutTiming] = useState<LayoutTiming | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [mapMinimumHeight, setMapMinimumHeight] = useState(608);
  const [legendHeight, setLegendHeight] = useState(64);
  const list = useRef<HTMLDivElement>(null), details = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const scroll = useRef(view.listScroll);
  const pane = useRef<HTMLElement>(null), paneScroll = useRef(view.paneScroll ?? 0);
  const client = useQueryClient();
  const discovery = useDiscovery(activePaperId, view.origin);
  const data = discovery.data ?? localMap(graph, view.origin);
  const emptyMap = data.nodes.length <= 1;
  const diagnostics = discoveryDiagnostics(data.warnings);
  const fetchErrors = [discovery.error || (discovery.isError ? discovery.failureReason?.message || "外部情報を取得できませんでした。" : ""),
    ...diagnostics.errors].filter(Boolean);
  const { data: records = [] } = useResearch(activePaperId);
  const imported = records.find(r => r.key === view.selectionKey && r.paper_id);
  const selected = data.nodes.find(n => n.id === (imported?.paper_id ?? view.selected));
  const effective = { ...view, selected: selected?.id ?? view.selected };
  const rows = mapRows(data, effective);
  const limit = view.diagramLimit && view.diagramLimit !== "auto" ? Number(view.diagramLimit) : paneWidth < 900 ? 20 : 30;
  const window = mapWindow(data, rows, effective, limit);
  const groups = mapGroups(window.nodes, data.edges, data.origin);
  const groupDescriptions = useGroupDescriptions(activePaperId, data, groups, !!discovery.data && !discovery.running && paneWidth > 0);
  const layout = useMemo(() => {
    const start = performance.now();
    const result = reconcileMapLayout(window.nodes, data.origin, selected && view.selected && selected.id !== view.selected && view.positions[view.selected]
      ? { ...view.positions, [selected.id]: view.positions[view.selected] } : view.positions, window.edges, groups, view.layoutKey);
    return { ...result, elapsedMs: performance.now() - start };
  }, [window.nodes, window.edges, groups, data.origin, view.positions, view.layoutKey, selected, view.selected]);
  const positions = layout.positions;
  const recordedLayout = useRef<typeof layout | null>(null);
  useLayoutEffect(() => {
    if (!legend.current) return;
    const observer = new ResizeObserver(entries => setLegendHeight(Math.ceil(entries[0].contentRect.height) + 18));
    observer.observe(legend.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!pane.current) return;
    setPaneWidth(pane.current.getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => setPaneWidth(entries[0].contentRect.width));
    observer.observe(pane.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!paneWidth || !discovery.data && !discovery.isError) return;
    // Stable geometry preserves edits. Changed communities or sizes repair overlapping saved geometry once.
    if (layout.key !== view.layoutKey || Object.keys(positions).some(id => positions[id].x !== view.positions[id]?.x || positions[id].y !== view.positions[id]?.y)) {
      setView(old => old.layoutKey === layout.key && old.positions !== view.positions ? old : ({ ...old, positions, layoutKey: layout.key,
        camera: layout.reflowed && !old.camera.manual ? { ...old.camera, fitted: false } : old.camera }));
      if (recordedLayout.current !== layout) {
        recordedLayout.current = layout;
        setLayoutTiming(old => ({ origin: data.origin, totalMs: (old?.origin === data.origin ? old.totalMs : 0) + layout.elapsedMs,
          count: (old?.origin === data.origin ? old.count : 0) + 1 }));
      }
    }
  }, [positions, view.positions, view.layoutKey, data.origin, layout, discovery.data, discovery.isError, paneWidth]);
  const current = data.nodes.find(n => n.id === data.origin);
  useLayoutEffect(() => {
    if (view.details && details.current) { details.current.scrollTop = 0; details.current.focus({ preventScroll: true }); }
  }, [selected?.id, view.details]);
  const reference = data.references.find(r => r.id === selected?.reference_id)
    ?? data.references.find(r => r.target === selected?.id);
  const source = reference?.source ?? activePaperId;
  const recordKey = view.selectionKey || selected?.research_key;
  const originPaperId = current?.paper_id ?? null;
  const references = data.references;
  const automation = useAutomaticResearch(originPaperId, references, reference?.research_key);
  useEffect(() => {
    if (activePaperId) mapViews.set(activePaperId, { view: { ...view, positions, layoutKey: layout.key, listScroll: view.details ? view.listScroll : scroll.current, paneScroll: paneScroll.current }, trail });
  }, [activePaperId, view, positions, layout.key, trail]);
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = view.listScroll;
    scroll.current = view.listScroll;
    if (pane.current) pane.current.scrollTop = view.paneScroll ?? 0;
  }, [view.origin, view.details, view.listScroll, view.paneScroll]);
  const update = (changes: Partial<SavedMapView>) => setView(old => ({ ...old, ...changes }));
  const closeDetails = () => {
    update({ details: false });
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>("button[aria-current=true]")?.focus({ preventScroll: true }));
  };
  const snapshot = () => ({ ...view, positions, layoutKey: layout.key, listScroll: view.details ? view.listScroll : scroll.current, paneScroll: paneScroll.current });
  const resetPositions = () => {
    const start = performance.now();
    const positions = mapPositions(window.nodes, data.origin, {}, window.edges, groups);
    const elapsedMs = performance.now() - start;
    update({ positions });
    setLayoutTiming(old => ({ origin: data.origin, totalMs: (old?.origin === data.origin ? old.totalMs : 0) + elapsedMs,
      count: (old?.origin === data.origin ? old.count : 0) + 1 }));
    return positions;
  };
  const restore = (state: SavedMapView, history: SavedMapView[]) => { setView(state); setTrail(history); setHover(null); setError(""); };
  async function select(node: MapNode) {
    const key = node.reference_id ? node.research_key : node.research_key || `map:${node.id}`;
    const listScroll = list.current?.scrollTop ?? scroll.current;
    setView(old => ({ ...old, selected: node.id, selectionKey: key, details: true, listScroll, positions }));
    setError("");
    requestAnimationFrame(() => details.current?.focus());
    if (!activePaperId || node.reference_id) return;
    setPreparing(node.id);
    try {
      const record = await unwrap(api.POST("/api/papers/{paper_id}/discovery/selection", {
        params: { path: { paper_id: activePaperId } }, body: { origin: view.origin, node_id: node.id },
      }));
      client.setQueryData([QK.research, activePaperId], (old: typeof records | undefined) => [...(old ?? []).filter(r => r.key !== record.key), record]);
      setView(old => old.selected === node.id ? { ...old, selectionKey: record.key } : old);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPreparing(old => old === node.id ? null : old); }
  }
  function explore(node: MapNode) {
    if (node.id === data.origin) return;
    setTrail(old => [...old, snapshot()]); setView(newView(node.id)); setHover(null); setError("");
  }
  if (!activePaperId) return <div className="p-6 text-muted-foreground">論文を開くと、論文マップから周辺の研究を探索できます。</div>;
  return <section ref={pane} className="@container flex flex-col flex-1 min-w-0 min-h-0 overflow-auto" aria-label="論文マップ" onScroll={e => {
    if (e.target !== e.currentTarget) return;
    paneScroll.current = e.currentTarget.scrollTop;
    const saved = mapViews.get(activePaperId); if (saved) saved.view.paneScroll = paneScroll.current;
  }}>
    <div className="px-4 py-3 border-b space-y-2 shrink-0">
      <div className="flex flex-wrap gap-2 items-center"><Network className="size-5 text-primary" /><h2 className="font-semibold">論文マップ</h2>
        {trail.length > 0 && <Button size="sm" variant="outline" onClick={() => restore(trail[trail.length - 1], trail.slice(0, -1))}><ArrowLeft />戻る</Button>}
        {trail.length > 0 && <Button size="sm" variant="ghost" onClick={() => restore(trail[0], [])}>元の論文に戻る</Button>}
        <Button size="sm" variant="ghost" className="ml-auto" disabled={discovery.running} onClick={discovery.refresh}><RefreshCw className={`size-3.5 ${discovery.running ? "animate-spin" : ""}`} />再取得</Button>
      </div>
      <p className="text-sm font-medium break-words line-clamp-2" title={current?.title}>起点：{current?.title ?? "論文を確認しています…"}</p>
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground" role="status">
        <span>{discovery.running ? "外部情報を取得中 · 保存済みの結果を表示" : discovery.enabled ? data.checked_at ? `取得済み ${new Date(data.checked_at).toLocaleDateString()}${data.stale ? " · 更新待ち" : ""}` : "保存済みの引用情報を表示" : "外部情報の自動取得はOFF"}</span>
        <details><summary className="cursor-pointer">取得範囲</summary><p className="mt-1 max-w-xl">{data.coverage}</p><MapTimings timing={data.timing} layout={layoutTiming?.origin === data.origin ? layoutTiming : null} /></details>
      </div>
      {diagnostics.notices.length > 0 && <details className="text-xs text-muted-foreground"><summary>探索範囲・照合結果 · 詳細</summary><p className="break-words whitespace-pre-line">{diagnostics.notices.join("\n")}</p></details>}
      {fetchErrors.length > 0 && <details className="text-xs text-amber-600"><summary>一部の情報を取得できませんでした · 詳細</summary><p className="break-words whitespace-pre-line">{fetchErrors.join("\n")}</p><Button size="sm" variant="ghost" disabled={discovery.running} onClick={discovery.refresh}>再試行</Button></details>}
      <div className="flex flex-wrap gap-2">
        <select aria-label="表示する論文" className="text-sm bg-background border rounded-md p-1.5 min-w-0" value={view.mode} onChange={e => update({ mode: e.target.value as MapMode, listScroll: 0 })}>{MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="登録状態" className="text-sm bg-background border rounded-md p-1.5" value={view.filter} onChange={e => update({ filter: e.target.value as SavedMapView["filter"], listScroll: 0 })}><option value="all">すべて</option><option value="registered">登録済み</option><option value="external">未登録</option></select>
        <select aria-label="図の表示件数" className="text-sm bg-background border rounded-md p-1.5" value={view.diagramLimit ?? "auto"}
          onChange={e => update({ diagramLimit: e.target.value as SavedMapView["diagramLimit"], positions: {}, camera: { x: 0, y: 0, zoom: 1 } })}>
          <option value="auto">図：自動（{paneWidth < 900 ? 20 : 30}件）</option><option value="20">図：20件</option><option value="40">図：40件</option><option value="60">図：60件</option>
        </select>
        <Input ref={searchInput} className="flex-1 min-w-40" aria-label="論文を検索" placeholder="タイトル・著者・DOIで検索" value={view.search} onChange={e => update({ search: e.target.value, listScroll: 0 })}
          onKeyDown={e => { if (e.key === "Escape" && !e.nativeEvent.isComposing && view.search) { e.preventDefault(); e.stopPropagation(); update({ search: "", listScroll: 0 }); } }} />
        {view.search && <Button size="sm" variant="ghost" aria-label="論文マップの検索語を消す" onClick={() => { update({ search: "", listScroll: 0 }); searchInput.current?.focus(); }}>解除</Button>}
      </div>
    </div>
    <AutoResearchControl state={automation} selectFailed={key => {
      const node = data.nodes.find(n => n.research_key === key);
      if (node) void select(node);
    }} />
    <div className="flex-1 min-h-[28rem] @[900px]:min-h-[38rem] overflow-hidden flex flex-col @[900px]:flex-row" style={emptyMap ? { minHeight: 0 } : paneWidth >= 900 ? { minHeight: mapMinimumHeight + legendHeight } : undefined}>
      <div className="flex flex-col h-[26rem] shrink-0 min-h-0 @[900px]:h-auto @[900px]:w-[65%] border-b @[900px]:border-b-0 @[900px]:border-r" style={emptyMap && paneWidth < 900 ? { height: "min(16rem, 40vh)" } : undefined}>
        {paneWidth > 0 && <MapNetwork nodes={window.nodes} edges={window.edges} allNodes={data.nodes} allEdges={data.edges} groups={groups} explanations={groupDescriptions} positions={positions} origin={data.origin} selected={effective.selected} hover={hover} setHover={setHover}
          camera={view.camera} setCamera={camera => update({ camera })} setPosition={(id, point) => update({ positions: { ...positions, [id]: point }, camera: { ...view.camera, manual: true } })}
          setLayout={(positions, camera, elapsedMs) => {
            update({ positions, camera, layoutKey: layout.key });
            setLayoutTiming(old => ({ origin: data.origin, totalMs: (old?.origin === data.origin ? old.totalMs : 0) + elapsedMs,
              count: (old?.origin === data.origin ? old.count : 0) + 1 }));
          }}
          setMinimumHeight={setMapMinimumHeight}
          select={id => { const node = data.nodes.find(n => n.id === id); if (node) void select(node); }} reset={resetPositions} />}
        <div ref={legend} className="border-t px-3 py-2 text-[0.75rem] text-muted-foreground shrink-0 flex flex-wrap gap-x-3 gap-y-1" aria-label="関係図の凡例">
          <details><summary className="cursor-pointer">図の見方</summary><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          <span title="引用する論文 → 引用される文献">実線 →：引用</span><span>起点の実線：直接引用</span><span>点線：類似・推薦・未照合の候補</span><span>▣：PDFあり</span><span>外周：選択中</span>
          <span>色・輪郭：引用のまとまり</span><span>円の大きさ：被引用数（{citationScope(window.nodes) === "external" ? `${externalCitationSources(window.nodes)}・未取得は最小の白抜き` : "ライブラリ内"}）</span>
          </div></details>
          <span>{window.nodes.length}件表示{window.omitted > 0 && ` · ${window.omitted}件省略（一覧から選択可能）`}</span>
          {window.context > 0 && <span>つながりを示す参考文献 {window.context}件を含む</span>}
        </div>
      </div>
      <div className="flex flex-col flex-1 min-w-0 min-h-0 @[900px]:w-[35%]">
        <div className={`${view.details && selected ? "hidden @[900px]:flex" : "flex"} px-3 py-2 border-b items-center gap-2 shrink-0`}>
          <span className="text-xs text-muted-foreground">文献一覧 {rows.length}件</span>
          <select aria-label="文献の並び順" className="ml-auto text-xs bg-background border rounded p-1 max-w-40" value={view.sort} onChange={e => update({ sort: e.target.value as SavedMapView["sort"] })}><option value="relevance">関連順</option><option value="newest">新しい順</option><option value="cited">ライブラリ内の被引用順</option></select>
        </div>
        <div ref={list} aria-label="文献一覧" className={`${view.details && selected ? "hidden @[900px]:block @[900px]:flex-[1_1_40%]" : "flex-1"} min-h-0 overflow-auto overscroll-contain`} onScroll={e => {
          scroll.current = e.currentTarget.scrollTop;
          const saved = mapViews.get(activePaperId); if (saved && !view.details) saved.view.listScroll = scroll.current;
        }}>
          {!rows.length && <div className="p-3 space-y-2 text-sm text-muted-foreground"><p role="status">{view.search || view.filter !== "all" || view.mode !== "nearby" ? "条件に一致する文献はありません。検索語や表示条件を変えてください。" : "この表示の候補はまだありません。取得済みの引用情報と外部探索の範囲で表示します。"}</p>
            {(view.search || view.filter !== "all" || view.mode !== "nearby") && <Button size="sm" variant="outline" onClick={() => { update({ search: "", filter: "all", mode: "nearby", listScroll: 0 }); searchInput.current?.focus(); }}>表示条件をリセット</Button>}
          </div>}
          {rows.map(n => <article key={n.id} className="border-b"><button aria-label={n.title} aria-current={n.id === selected?.id ? "true" : undefined}
            onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(n.id)} onBlur={() => setHover(null)}
            className={`w-full px-3 py-2 text-left space-y-1 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 ${n.id === selected?.id || hover === n.id ? "bg-primary/5" : ""}`} onClick={() => void select(n)}>
            <span className="block text-sm font-medium leading-relaxed break-words">{n.title}</span>
            <span className="block text-xs text-muted-foreground">{[n.year, n.first_author, n.paper_id ? "PDFあり" : "未登録"].filter(Boolean).join(" · ")}</span>
            <span className="block text-[0.75rem] text-muted-foreground">{n.reasons.join(" · ")}</span>
            <span className="block text-[0.75rem] text-muted-foreground">被引用 {n.local_citations}件（ライブラリ内）{n.external_citations !== null && ` · ${n.external_citations}件（${externalCitationSource(n)}）`}</span>
          </button></article>)}
        </div>
        {view.details && selected && <div ref={details} tabIndex={-1} className="flex-1 @[900px]:flex-[1_1_60%] border-t min-h-0 overflow-auto overscroll-contain p-3 space-y-2 outline-none" aria-label="選択した文献の詳細"
          onKeyDown={e => { if (e.key === "Escape" && !e.defaultPrevented && !e.nativeEvent.isComposing && !(e.target as HTMLElement).closest("input, textarea, select, [role=dialog], [role=menu]")) { e.preventDefault(); e.stopPropagation(); closeDetails(); } }}>
          <Button size="sm" variant="ghost" onClick={closeDetails}><ArrowLeft />一覧に戻る</Button>
          <h3 className="font-semibold break-words leading-relaxed">{selected.title}</h3>
          <p className="text-xs text-muted-foreground">{[selected.year, selected.first_author, selected.paper_id ? "PDFあり" : "未登録"].filter(Boolean).join(" · ")}</p>
          <p className="text-xs text-muted-foreground">被引用 {selected.local_citations}件（ライブラリ内）{selected.external_citations !== null && ` · ${selected.external_citations}件（${externalCitationSource(selected)}）`}</p>
          <ul className="text-xs text-muted-foreground space-y-1">{selected.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
          <Button size="sm" variant="outline" onClick={() => explore(selected)} disabled={selected.id === data.origin}><Network />この論文を中心に見る</Button>
          {selected.abstract && !records.find(r => r.key === recordKey)?.abstract && <details className="text-xs"><summary className="cursor-pointer">取得した抄録（原文）</summary><p className="mt-2 break-words whitespace-pre-wrap leading-relaxed">{selected.abstract}</p><p className="mt-2 text-muted-foreground">取得元：{selected.provenance.filter(p => p !== "library").join(" · ")}{selected.acquired_at && ` · ${new Date(selected.acquired_at).toLocaleDateString()}`}</p></details>}
          {error && <p role="alert" className="text-xs text-destructive break-words">{error}</p>}
          {preparing === selected.id ? <p role="status" className="text-xs">文献の詳細を準備しています…</p> : source && <ResearchDetails key={recordKey ?? selected.id} sourcePaperId={source} reference={reference} recordKey={reference ? undefined : recordKey} registeredPaperId={selected.paper_id} showInformationSettings={false} />}
          {reference && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">書誌情報・取得元・引用元</summary><div className="pt-3 space-y-3">
            <p className="break-words leading-relaxed">{reference.raw}</p>
            <p>取得元：{[...new Set((reference.provenance ?? []).map(p => p.provider))].join(" · ") || "PDF"}</p>
            {(reference.provenance?.filter(p => p.provider === "PDF" && p.page) ?? (reference.page ? [{ page: reference.page, label: reference.label }] : [])).map((p, i) => <Button key={i} size="sm" variant="outline" onClick={() => {
              openReferencePaper(activePaperId, reference.source); navigateTo({ page: p.page! });
            }}>引用元を確認する p.{p.page}{p.label && ` [${p.label}]`}</Button>)}
          </div></details>}
        </div>}
      </div>
    </div>
  </section>;
}
