import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useEdgesState,
  useNodesState,
  useReactFlow,
  addEdge,
  type Connection,
  type Edge,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  createChain,
  createPool,
  deleteChain,
  deletePool,
  listAllNodes,
  listChains,
  listPools,
  updateChain,
  updatePool,
} from "../api";
import { GlassButton } from "../components/GlassButton";
import { GlassSeg } from "../components/GlassSeg";
import { ErrorModal } from "../components/ErrorModal";
import { useI18n } from "../i18n";
import type { ChainHop, NodePool, PoolMode, ProxyChain, ProxyNode } from "../types";

/** Display label for one hop, resolved against the current node/pool lists. */
function hopLabel(
  hop: ChainHop,
  nodeById: Map<string, ProxyNode>,
  poolById: Map<string, NodePool>,
): { text: string; stale: boolean } {
  if (hop.kind === "node") {
    const n = nodeById.get(hop.node_id);
    return n ? { text: n.name, stale: false } : { text: hop.node_id, stale: true };
  }
  const p = poolById.get(hop.pool_id);
  return p ? { text: `📦 ${p.name}`, stale: false } : { text: hop.pool_id, stale: true };
}

/** Custom flow node: a hop capsule with left/right connection handles (only
 *  one incoming, one outgoing edge is meaningful for a linear chain, but
 *  xyflow doesn't enforce that — `hopsFromGraph` validates it on save). */
function HopNode({ data }: NodeProps) {
  const label = data.label as string;
  const stale = data.stale as boolean;
  return (
    <div className={`chain-hop-node${stale ? " stale" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <span>{label}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { hop: HopNode };

/** Walk the graph from whichever node has no incoming edge and return hops
 *  in order. Returns `null` if the graph isn't a single simple path (a
 *  branch, a cycle, an isolated node, or more than one component) — chains
 *  only support straight-line hops. */
function hopsFromGraph(
  flowNodes: FlowNode[],
  edges: Edge[],
): { id: string; hop: ChainHop }[] | null {
  if (flowNodes.length === 0) return [];
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const n of flowNodes) {
    outgoing.set(n.id, []);
    incoming.set(n.id, 0);
  }
  for (const e of edges) {
    if (!outgoing.has(e.source) || !incoming.has(e.target)) continue;
    outgoing.get(e.source)!.push(e.target);
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
  }
  // Every node must have out-degree <= 1 and in-degree <= 1 for a simple path.
  for (const n of flowNodes) {
    if ((outgoing.get(n.id)?.length ?? 0) > 1) return null;
    if ((incoming.get(n.id) ?? 0) > 1) return null;
  }
  const starts = flowNodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  if (starts.length !== 1) return null; // no unique entry, or a cycle with no start
  const order: FlowNode[] = [];
  let cur: FlowNode | undefined = starts[0];
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur.id)) return null; // cycle
    seen.add(cur.id);
    order.push(cur);
    const nextId: string | undefined = outgoing.get(cur.id)?.[0];
    cur = nextId ? flowNodes.find((n) => n.id === nextId) : undefined;
  }
  if (order.length !== flowNodes.length) return null; // disconnected node(s)
  return order.map((n) => ({
    id: n.id,
    hop: n.data.hop as ChainHop,
  }));
}

function hopFlowId(hop: ChainHop): string {
  return hop.kind === "node" ? `node:${hop.node_id}` : `pool:${hop.pool_id}`;
}

/** Lay hops out left-to-right at a fixed spacing (used both for loading an
 *  existing chain and for a freshly-dropped candidate). */
function layoutHops(
  hops: ChainHop[],
  nodeById: Map<string, ProxyNode>,
  poolById: Map<string, NodePool>,
): FlowNode[] {
  return hops.map((hop, i) => {
    const { text, stale } = hopLabel(hop, nodeById, poolById);
    return {
      id: hopFlowId(hop),
      type: "hop",
      position: { x: 40 + i * 200, y: 80 },
      data: { label: text, stale, hop },
    };
  });
}

function edgesFromHops(hops: ChainHop[]): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < hops.length - 1; i++) {
    out.push({
      id: `${hopFlowId(hops[i])}->${hopFlowId(hops[i + 1])}`,
      source: hopFlowId(hops[i]),
      target: hopFlowId(hops[i + 1]),
    });
  }
  return out;
}

function PoolCard({
  pool,
  onEdit,
  onDelete,
}: {
  pool: NodePool;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const memberCount =
    pool.mode.mode === "explicit"
      ? pool.mode.node_ids.length
      : null;
  const summary =
    pool.mode.mode === "explicit"
      ? `${memberCount} ${t("chain.poolMembersSuffix")}`
      : [
          pool.mode.include.length ? `+${pool.mode.include.join(" +")}` : "",
          pool.mode.exclude.length ? `-${pool.mode.exclude.join(" -")}` : "",
        ]
          .filter(Boolean)
          .join(" ") || t("chain.poolKeywordAll");
  return (
    <div className="card chain-pool-card">
      <div className="chain-pool-card-head">
        <span className="chain-pool-name">{pool.name}</span>
        <span className={`pill ${pool.mode.mode === "explicit" ? "target-node" : "target-smart"}`}>
          {pool.mode.mode === "explicit" ? t("chain.poolModeExplicit") : t("chain.poolModeKeyword")}
        </span>
      </div>
      <p className="muted chain-pool-summary">{summary}</p>
      <div className="chain-pool-card-actions">
        <GlassButton onClick={onEdit}>{t("common.edit")}</GlassButton>
        <GlassButton variant="danger" onClick={onDelete}>
          {t("common.delete")}
        </GlassButton>
      </div>
    </div>
  );
}

function PoolEditorModal({
  pool,
  nodes,
  onClose,
  onSaved,
}: {
  /** `null` = creating a new pool. */
  pool: NodePool | null;
  nodes: ProxyNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(pool?.name ?? "");
  const [mode, setMode] = useState<"explicit" | "keyword">(pool?.mode.mode ?? "explicit");
  const [nodeIds, setNodeIds] = useState<Set<string>>(
    new Set(pool?.mode.mode === "explicit" ? pool.mode.node_ids : []),
  );
  const [include, setInclude] = useState(
    pool?.mode.mode === "keyword" ? pool.mode.include.join(" ") : "",
  );
  const [exclude, setExclude] = useState(
    pool?.mode.mode === "keyword" ? pool.mode.exclude.join(" ") : "",
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((n) => n.name.toLowerCase().includes(q));
  }, [nodes, query]);

  function toggleNode(id: string) {
    setNodeIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function parseKeywords(raw: string): string[] {
    return raw
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function onSubmit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("chain.needPoolName"));
      return;
    }
    const poolMode: PoolMode =
      mode === "explicit"
        ? { mode: "explicit", node_ids: Array.from(nodeIds) }
        : { mode: "keyword", include: parseKeywords(include), exclude: parseKeywords(exclude) };
    if (poolMode.mode === "explicit" && poolMode.node_ids.length === 0) {
      setError(t("chain.needPoolNodes"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (pool) {
        await updatePool(pool.id, trimmed, poolMode);
      } else {
        await createPool(trimmed, poolMode);
      }
      onSaved();
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal rules-form-modal">
        <header className="modal-header">
          <h2>{pool ? t("chain.editPool") : t("chain.newPool")}</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>{t("chain.poolName")}</span>
            <input
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("chain.poolNamePh")}
              maxLength={64}
              autoFocus
            />
          </label>
          <label className="field">
            <span>{t("chain.poolMode")}</span>
            <GlassSeg
              value={mode}
              ariaLabel={t("chain.poolMode")}
              onChange={(v) => setMode(v as "explicit" | "keyword")}
              options={[
                { value: "explicit", label: t("chain.poolModeExplicit") },
                { value: "keyword", label: t("chain.poolModeKeyword") },
              ]}
            />
          </label>
          {mode === "explicit" ? (
            <div className="field rule-node-pick">
              <span>{t("chain.poolPickNodes")}</span>
              {nodes.length === 0 ? (
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {t("rules.noNodes")}
                </p>
              ) : (
                <>
                  <input
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("rules.pickNodePh")}
                  />
                  <div className="chain-pool-node-list">
                    {filteredNodes.map((n) => (
                      <label key={n.id} className="chain-pool-node-item">
                        <input
                          type="checkbox"
                          checked={nodeIds.has(n.id)}
                          onChange={() => toggleNode(n.id)}
                        />
                        <span>{n.name}</span>
                      </label>
                    ))}
                  </div>
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
                    {t("chain.poolSelectedCount", { n: nodeIds.size })}
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="field rule-smart-filters">
              <label className="field" style={{ marginBottom: 8 }}>
                <span>{t("rules.smartInclude")}</span>
                <input
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={include}
                  onChange={(e) => setInclude(e.target.value)}
                  placeholder={t("rules.smartIncludePh")}
                />
              </label>
              <label className="field">
                <span>{t("rules.smartExclude")}</span>
                <input
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={exclude}
                  onChange={(e) => setExclude(e.target.value)}
                  placeholder={t("rules.smartExcludePh")}
                />
              </label>
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={busy} onClick={() => void onSubmit()}>
            {t("common.save")}
          </GlassButton>
        </footer>
      </div>
      {error && <ErrorModal message={error} onClose={() => setError(null)} />}
    </div>
  );
}

function ChainFlowEditor({
  chain,
  nodes,
  pools,
  nodeById,
  poolById,
  onSubmit,
  busy,
  onClose,
}: {
  chain: ProxyChain | null;
  nodes: ProxyNode[];
  pools: NodePool[];
  nodeById: Map<string, ProxyNode>;
  poolById: Map<string, NodePool>;
  onSubmit: (flowNodes: FlowNode[], edges: Edge[]) => void;
  busy: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<FlowNode>(
    layoutHops(chain?.hops ?? [], nodeById, poolById),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    edgesFromHops(chain?.hops ?? []),
  );
  const [candidateKind, setCandidateKind] = useState<"node" | "pool">("node");
  // Manual pointer-based drag: WKWebView (macOS Tauri) doesn't reliably fire
  // HTML5 drag-and-drop events (dragstart/drop over DataTransfer), so the
  // sidebar → canvas drag is implemented with pointer events instead — a
  // "ghost" label follows the cursor, and dropping is resolved by hit-testing
  // the canvas element under the pointer on release.
  const [dragging, setDragging] = useState<
    { hop: ChainHop; label: string; x: number; y: number } | null
  >(null);
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;

  // `fitView` as a mount-time prop is a no-op on an empty canvas (new chain)
  // and can leave the viewport in an undefined zoom/pan state — every hop
  // added afterwards would then land outside the visible area even though
  // its flow coordinates are correct. Re-fit explicitly whenever the node
  // count changes instead (covers the initial edit-existing-chain load too).
  useEffect(() => {
    if (flowNodes.length === 0) return;
    // Let the just-added node's DOM measurement land before fitting.
    const raf = requestAnimationFrame(() => {
      fitView({ padding: 0.3, duration: 200 });
    });
    return () => cancelAnimationFrame(raf);
  }, [flowNodes.length, fitView]);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  function dropHopAt(hop: ChainHop, clientX: number, clientY: number) {
    const id = hopFlowId(hop);
    if (flowNodes.some((n) => n.id === id)) return; // already on the canvas
    const { text, stale } = hopLabel(hop, nodeById, poolById);
    const position = screenToFlowPosition({ x: clientX, y: clientY });
    setFlowNodes((cur) => [
      ...cur,
      { id, type: "hop", position, data: { label: text, stale, hop } },
    ]);
  }

  useEffect(() => {
    if (!dragging) return;

    function onMove(e: PointerEvent) {
      setDragging((cur) => (cur ? { ...cur, x: e.clientX, y: e.clientY } : cur));
    }

    function onUp(e: PointerEvent) {
      const current = draggingRef.current;
      setDragging(null);
      if (!current) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const overCanvas = !!canvasRef.current && !!target && canvasRef.current.contains(target);
      if (overCanvas) {
        dropHopAt(current.hop, e.clientX, e.clientY);
      }
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    // dropHopAt/draggingRef are read through refs/closures scoped to this
    // effect's own render — re-running only on dragging's presence (not its
    // x/y) avoids tearing down/re-attaching listeners on every pointermove.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging !== null]);

  function onCandidatePointerDown(e: React.PointerEvent, hop: ChainHop, label: string) {
    e.preventDefault();
    setDragging({ hop, label, x: e.clientX, y: e.clientY });
  }

  function removeSelected() {
    setFlowNodes((cur) => cur.filter((n) => !n.selected));
    setEdges((cur) => cur.filter((e) => !e.selected));
  }

  return (
    <>
      <div className="modal-body chain-editor-body">
        <p className="muted chain-editor-hint">{t("chain.editorHint")}</p>
        <div className="chain-editor-layout">
          <aside className="chain-editor-sidebar">
            <GlassSeg
              value={candidateKind}
              ariaLabel={t("chain.candidateKind")}
              onChange={(v) => setCandidateKind(v as "node" | "pool")}
              options={[
                { value: "node", label: t("rules.pickNode") },
                { value: "pool", label: t("chain.pool") },
              ]}
            />
            <div className="chain-candidate-list">
              {candidateKind === "node"
                ? nodes.map((n) => (
                    <div
                      key={n.id}
                      onPointerDown={(e) =>
                        onCandidatePointerDown(e, { kind: "node", node_id: n.id }, n.name)
                      }
                      className="chain-candidate-item"
                      title={t("chain.dragHint")}
                    >
                      {n.name}
                    </div>
                  ))
                : pools.map((p) => (
                    <div
                      key={p.id}
                      onPointerDown={(e) =>
                        onCandidatePointerDown(e, { kind: "pool", pool_id: p.id }, `📦 ${p.name}`)
                      }
                      className="chain-candidate-item"
                      title={t("chain.dragHint")}
                    >
                      📦 {p.name}
                    </div>
                  ))}
              {candidateKind === "node" && nodes.length === 0 && (
                <p className="muted" style={{ fontSize: 12 }}>
                  {t("rules.noNodes")}
                </p>
              )}
              {candidateKind === "pool" && pools.length === 0 && (
                <p className="muted" style={{ fontSize: 12 }}>
                  {t("chain.noPools")}
                </p>
              )}
            </div>
            <GlassButton onClick={removeSelected}>{t("chain.removeSelected")}</GlassButton>
          </aside>
          <div className="chain-editor-canvas" ref={canvasRef}>
            <ReactFlow
              nodes={flowNodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              minZoom={0.2}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </div>
      </div>
      {dragging && (
        <div className="chain-drag-ghost" style={{ left: dragging.x, top: dragging.y }}>
          {dragging.label}
        </div>
      )}
      <footer className="modal-footer">
        <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
        <GlassButton
          variant="primary"
          disabled={busy}
          onClick={() => onSubmit(flowNodes, edges)}
        >
          {t("common.save")}
        </GlassButton>
      </footer>
    </>
  );
}

function ChainEditorModal({
  chain,
  nodes,
  pools,
  onClose,
  onSaved,
}: {
  /** `null` = creating a new chain. */
  chain: ProxyChain | null;
  nodes: ProxyNode[];
  pools: NodePool[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const poolById = useMemo(() => new Map(pools.map((p) => [p.id, p])), [pools]);

  const [name, setName] = useState(chain?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(flowNodes: FlowNode[], edges: Edge[]) {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("chain.needChainName"));
      return;
    }
    const ordered = hopsFromGraph(flowNodes, edges);
    if (ordered === null) {
      setError(t("chain.needLinearChain"));
      return;
    }
    if (ordered.length < 2) {
      setError(t("chain.needAtLeastTwoHops"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hops = ordered.map((o) => o.hop);
      if (chain) {
        await updateChain(chain.id, trimmed, hops);
      } else {
        await createChain(trimmed, hops);
      }
      onSaved();
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal chain-editor-modal">
        <header className="modal-header">
          <h2>{chain ? t("chain.editChain") : t("chain.newChain")}</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <label className="field chain-editor-name-field">
          <span>{t("chain.chainName")}</span>
          <input
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("chain.chainNamePh")}
            maxLength={64}
            autoFocus
          />
        </label>
        <ReactFlowProvider>
          <ChainFlowEditor
            chain={chain}
            nodes={nodes}
            pools={pools}
            nodeById={nodeById}
            poolById={poolById}
            onSubmit={onSubmit}
            busy={busy}
            onClose={onClose}
          />
        </ReactFlowProvider>
      </div>
      {error && <ErrorModal message={error} onClose={() => setError(null)} />}
    </div>
  );
}

export function ChainPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const [pools, setPools] = useState<NodePool[]>([]);
  const [chains, setChains] = useState<ProxyChain[]>([]);
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [poolEditor, setPoolEditor] = useState<{ pool: NodePool | null } | null>(null);
  const [chainEditor, setChainEditor] = useState<{ chain: ProxyChain | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: "pool" | "chain"; id: string; name: string } | null
  >(null);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const poolById = useMemo(() => new Map(pools.map((p) => [p.id, p])), [pools]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, c, n] = await Promise.all([listPools(), listChains(), listAllNodes()]);
      setPools(p);
      setChains(c);
      setNodes(n);
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onConfirmDelete() {
    if (!confirmDelete) return;
    try {
      if (confirmDelete.kind === "pool") {
        await deletePool(confirmDelete.id);
      } else {
        await deleteChain(confirmDelete.id);
      }
      setConfirmDelete(null);
      await reload();
    } catch (err) {
      setConfirmDelete(null);
      setError(typeof err === "string" ? err : String(err));
    }
  }

  return (
    <div className={embedded ? "settings-embed chain-embed" : "page chain-page"}>
      {!embedded && (
        <header className="page-header">
          <div>
            <h1>{t("chain.title")}</h1>
            <p className="page-desc">{t("chain.desc")}</p>
          </div>
        </header>
      )}

      <section className="chain-section">
        <div className="chain-section-head">
          <h2>{t("chain.poolsHeading")}</h2>
          <GlassButton variant="primary" onClick={() => setPoolEditor({ pool: null })}>
            {t("chain.newPool")}
          </GlassButton>
        </div>
        {loading ? (
          <p className="muted">{t("common.loading")}</p>
        ) : pools.length === 0 ? (
          <p className="muted">{t("chain.noPoolsYet")}</p>
        ) : (
          <div className="chain-pool-grid">
            {pools.map((p) => (
              <PoolCard
                key={p.id}
                pool={p}
                onEdit={() => setPoolEditor({ pool: p })}
                onDelete={() => setConfirmDelete({ kind: "pool", id: p.id, name: p.name })}
              />
            ))}
          </div>
        )}
      </section>

      <section className="chain-section">
        <div className="chain-section-head">
          <h2>{t("chain.chainsHeading")}</h2>
          <GlassButton variant="primary" onClick={() => setChainEditor({ chain: null })}>
            {t("chain.newChain")}
          </GlassButton>
        </div>
        {loading ? (
          <p className="muted">{t("common.loading")}</p>
        ) : chains.length === 0 ? (
          <p className="muted">{t("chain.noChainsYet")}</p>
        ) : (
          <div className="chain-list">
            {chains.map((c) => (
              <div key={c.id} className="card chain-card">
                <div className="chain-card-head">
                  <span className="chain-card-name">{c.name}</span>
                  <div className="chain-card-actions">
                    <GlassButton onClick={() => setChainEditor({ chain: c })}>
                      {t("common.edit")}
                    </GlassButton>
                    <GlassButton
                      variant="danger"
                      onClick={() => setConfirmDelete({ kind: "chain", id: c.id, name: c.name })}
                    >
                      {t("common.delete")}
                    </GlassButton>
                  </div>
                </div>
                <div className="chain-card-hops">
                  {c.hops.map((hop, i) => {
                    const { text, stale } = hopLabel(hop, nodeById, poolById);
                    return (
                      <span key={i} className="chain-hop-chip-wrap">
                        <span className={`chain-hop-chip${stale ? " stale" : ""}`}>{text}</span>
                        {i < c.hops.length - 1 && <span className="chain-hop-arrow">→</span>}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {poolEditor && (
        <PoolEditorModal
          pool={poolEditor.pool}
          nodes={nodes}
          onClose={() => setPoolEditor(null)}
          onSaved={() => {
            setPoolEditor(null);
            void reload();
          }}
        />
      )}
      {chainEditor && (
        <ChainEditorModal
          chain={chainEditor.chain}
          nodes={nodes}
          pools={pools}
          onClose={() => setChainEditor(null)}
          onSaved={() => {
            setChainEditor(null);
            void reload();
          }}
        />
      )}
      {confirmDelete && (
        <div className="modal-backdrop">
          <div className="modal">
            <header className="modal-header">
              <h2>{t("common.confirm")}</h2>
            </header>
            <div className="modal-body">
              <p>
                {confirmDelete.kind === "pool"
                  ? t("chain.confirmDeletePool", { name: confirmDelete.name })
                  : t("chain.confirmDeleteChain", { name: confirmDelete.name })}
              </p>
            </div>
            <footer className="modal-footer">
              <GlassButton onClick={() => setConfirmDelete(null)}>
                {t("common.cancel")}
              </GlassButton>
              <GlassButton variant="danger" onClick={() => void onConfirmDelete()}>
                {t("common.delete")}
              </GlassButton>
            </footer>
          </div>
        </div>
      )}
      {error && <ErrorModal message={error} onClose={() => setError(null)} />}
    </div>
  );
}
