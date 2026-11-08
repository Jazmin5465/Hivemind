import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Minus, RotateCcw, X, Truck } from "lucide-react";
import { useTick } from "@/hooks/use-countdown";
import { hexPoints, type GeoModel } from "@/lib/live/geoLayout";
import type { LiveData } from "@/lib/live/store";
import { useLive } from "@/components/LiveProvider";
import { PageBackdrop } from "@/components/PageBackdrop";
import { effectiveNow, fleetTrucks, fleets as liveFleets, formatTime, mapModel, nowOf, thresholdsOf, type MapNode, type SystemBox } from "@/lib/live/derive";

export const Route = createFileRoute("/map")({
  validateSearch: (s: Record<string, unknown>): { facility?: string | undefined } => ({ facility: typeof s["facility"] === "string" ? s["facility"] : undefined }),
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { title: "Hivemind — Network Map" },
      { name: "description", content: "Interactive schematic of facilities, tanks, pumps, pipelines and disposal sites grouped by system." },
      { property: "og:title", content: "Hivemind — Network Map" },
      { property: "og:description", content: "Interactive salt water network schematic with live failure propagation." },
    ],
  }),
  component: MapPage,
});

const statusVar = { ok: "var(--primary)", warn: "var(--warning)", fail: "var(--destructive)" } as const;
const kindLabel = { facility: "FAC", tank: "TNK", pump: "PMP", disposal: "SWD", well: "WELL", yard: "YRD" } as const;

function MapPage() {
  const { facility } = Route.useSearch();
  const live = useLive();
  useTick(); // trucks move along their routes in real time
  // layout sized from the live network (any number of systems / facilities); recomputed only on data changes
  const model = useMemo(() => mapModel(live), [live]);
  const geo = model.geo;
  const now = effectiveNow(live);
  const { W, H, nodes: mapNodes, edges: mapEdges, boxes: systemBoxes, geoNodes, geoEdges } = model;
  const thresholds = thresholdsOf(live);
  const sizeRef = useRef({ W, H });
  sizeRef.current = { W, H };
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("ALL");
  const [mode, setMode] = useState<"schematic" | "geo">("schematic");
  const nodes = mode === "geo" ? geoNodes : mapNodes;
  const edges = mode === "geo" ? geoEdges : mapEdges;
  // keep the inspector showing live values: look the selected node up in the current model
  const selected: MapNode | null = selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null;
  const setSelected = (n: MapNode | null) => setSelectedId(n?.id ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [animate, setAnimate] = useState(false);

  const zoomAt = (px: number, py: number, next: number) => {
    const v = viewRef.current;
    const k = Math.min(4, Math.max(0.5, next));
    const r = k / v.k;
    setView({ k, x: px - (px - v.x) * r, y: py - (py - v.y) * r });
  };

  const zoomToBox = (box: SystemBox) => {
    const k = Math.min(3, W / (box.w + 60), H / (box.h + 40));
    setView({ k, x: W / 2 - (box.x + box.w / 2) * k, y: H / 2 - (box.y + box.h / 2) * k });
  };

  const selectTab = (id: string) => {
    setAnimate(true);
    setTab(id);
    if (id === "ALL" || mode === "geo") {
      if (mode === "geo" && id !== "ALL") {
        const pts = geoNodes.filter((n) => n.system === id).map((n) => ({ x: n.x, y: n.y }));
        // keep the system's card in view too
        const card = geo.cards.find((c) => c.system === id);
        if (card) pts.push({ x: card.x, y: card.y }, { x: card.x + card.w, y: card.y + card.h });
        const xs = pts.map((n) => n.x), ys = pts.map((n) => n.y);
        const x0 = Math.min(...xs), y0 = Math.min(...ys);
        zoomToBox({ id, x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0, trucks: 0, health: "NORMAL" });
      } else setView({ x: 0, y: 0, k: 1 });
    } else {
      const box = systemBoxes.find((b) => b.id === id);
      if (box) zoomToBox(box);
    }
  };

  // Deep-link from the dashboard: select and zoom to the facility's system.
  useEffect(() => {
    if (!facility || !live.ready) return;
    const node = mapNodes.find((n) => n.id === facility);
    if (node) {
      setSelected(node);
      selectTab(node.system);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facility, live.ready]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setAnimate(false);
      const rect = el.getBoundingClientRect();
      const scale = sizeRef.current.W / rect.width;
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      zoomAt((e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale, viewRef.current.k * Math.exp(-dy * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const node = (id: string) => nodes.find((n) => n.id === id);
  const visibleNodes = nodes.filter((n) => tab === "ALL" || n.system === tab);
  const visibleEdges = edges.filter((e) => tab === "ALL" || e.system === tab);
  const selectedState = selected?.kind === "facility" ? live.facilityStates.find((f) => f.facilityId === selected.id) : undefined;
  const selectedLogistics = selectedState ? live.opsFacilities.find((f) => f.facilityId === selectedState.facilityId) : undefined;
  const lvl = selectedState?.levelPct ?? 0;
  const bpd = (v: number | undefined) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(0));

  return (
    <>
    <PageBackdrop layers={[{ src: "/art/tracks.jpg", opacity: 0.16, position: "center", size: "cover" }]} />
    <main className="relative z-10 mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-heading text-3xl tracking-[0.12em] text-heading-pink glow-magenta-soft md:text-4xl">NETWORK MAP</h1>
          <p className="font-subheading text-sm text-muted-foreground">{tab === "ALL" ? "All systems" : `Isolated ${tab}`} · {mode === "geo" ? "real layouts · spacing between systems compressed" : "schematic"} · Last updated: {live.ready ? formatTime(nowOf(live)) : "—"}</p>
        </div>
        <div className="flex gap-3 font-mono text-[10px] uppercase">
          <span className="text-primary">● Normal</span><span className="text-warning">● Warning</span><span className="text-destructive">● Failing</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <div role="group" aria-label="Map view" className="mr-2 flex">
          {([["schematic", "Schematic"], ["geo", "Geographic"]] as const).map(([m, l]) => (
            <Button variant="ghost" key={m} aria-pressed={mode === m}
              onClick={() => { setMode(m); setTab("ALL"); setView({ x: 0, y: 0, k: 1 }); setSelected(null); }}
              className={`px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] ${mode === m ? "bg-primary text-primary-foreground" : "glass text-muted-foreground hover:text-primary"}`}>{l}</Button>
          ))}
        </div>
        {["ALL", ...systemBoxes.map((b) => b.id)].map((id) => (
          <Button
            variant="ghost"
            key={id}
            onClick={() => selectTab(id)}
            className={`clip-corner px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] transition ${tab === id ? "bg-foreground text-background" : "glass text-muted-foreground hover:text-primary"}`}
          >
            {id === "ALL" ? "All Systems" : id}
          </Button>
        ))}
      </div>

      <div ref={ref} className="glass relative overflow-hidden rounded touch-none cursor-grab active:cursor-grabbing"
        onPointerDown={(e) => { setAnimate(false); drag.current = { x: e.clientX, y: e.clientY }; (e.target as Element).setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => {
          if (!drag.current || !ref.current) return;
          const s = W / ref.current.getBoundingClientRect().width;
          const dx = (e.clientX - drag.current.x) * s, dy = (e.clientY - drag.current.y) * s;
          drag.current = { x: e.clientX, y: e.clientY };
          setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
        }}
        onPointerUp={() => (drag.current = null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-[70vh] min-h-96 w-full">
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="var(--border)" strokeWidth="0.5" /></pattern>
            <filter id="glow"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          <rect width={W} height={H} fill="url(#grid)" />
          <g style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0", transition: animate ? "transform 700ms cubic-bezier(0.65, 0, 0.35, 1)" : "none" }}>
            {mode === "geo" && <GeoHoneycomb geo={geo} tab={tab} />}
            {mode === "geo" && <GeoRoutes geo={geo} tab={tab} />}
            {mode === "schematic" && systemBoxes.filter((b) => tab === "ALL" || b.id === tab).map((b) => (
              <g key={b.id}>
                <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="10" fill="oklch(0.17 0.03 290 / 0.88)" stroke={b.health === "CRITICAL" ? "var(--destructive)" : "var(--primary)"} strokeWidth="1" opacity="0.9" filter="url(#glow)" />
                <text x={b.x + b.w / 2} y={b.y + 22} textAnchor="middle" fontSize="12" fontWeight="bold" fontFamily="JetBrains Mono" fill="var(--primary)">SYSTEM {b.id}</text>
                <text x={b.x + b.w / 2} y={b.y + 38} textAnchor="middle" fontSize="9" fontFamily="JetBrains Mono" fill="var(--muted-foreground)">{b.trucks} TRUCKS · <tspan fill={b.health === "CRITICAL" ? "var(--destructive)" : "var(--ok)"}>{b.health}</tspan></text>
              </g>
            ))}
            {visibleEdges.map((e) => {
              const a = node(e.from), b = node(e.to);
              if (!a || !b) return null;
              const d = mode === "geo" ? `M${a.x} ${a.y} L ${b.x} ${b.y}` : `M${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${(a.y + b.y) / 2 - 30} ${b.x} ${b.y}`;
              const col = e.failing ? "var(--destructive)" : "var(--primary)";
              return (
                <g key={e.id}>
                  <path d={d} fill="none" stroke={col} strokeWidth="6" opacity="0.12" />
                  <path d={d} fill="none" stroke={col} strokeWidth="1.5" strokeDasharray="6 14" className="animate-dash" filter="url(#glow)" opacity={e.failing ? 1 : 0.6} />
                  {[0, 1, 2].map((i) => (
                    <circle key={i} r={e.failing ? 4 : 2.5} fill={e.failing ? "var(--destructive)" : "var(--accent)"} filter="url(#glow)">
                      <animateMotion dur={e.failing ? "1.6s" : "4s"} begin={`${i * (e.failing ? 0.53 : 1.3)}s`} repeatCount="indefinite" path={d} />
                    </circle>
                  ))}
                </g>
              );
            })}
            {visibleNodes.map((n) => (
              <g key={n.id} transform={`translate(${n.x} ${n.y}) scale(${mode === "geo" ? 0.55 : 1})`} className="cursor-pointer" onPointerDown={(e) => e.stopPropagation()} onClick={() => setSelected(n)}>
                {n.status !== "ok" && <circle r="30" fill={statusVar[n.status]} opacity="0.3" className="animate-pulse-glow" filter="url(#glow)" />}
                <circle r="24" fill={statusVar[n.status]} opacity="0.12" />
                {n.kind === "facility" || n.kind === "yard" ? (
                  <rect x="-15" y="-15" width="30" height="30" fill="var(--background)" stroke={statusVar[n.status]} strokeWidth="2" filter="url(#glow)" />
                ) : (
                  <circle r="15" fill="var(--background)" stroke={statusVar[n.status]} strokeWidth="2" filter="url(#glow)" />
                )}
                <text y="4" textAnchor="middle" fontSize="9" fontFamily="JetBrains Mono" fill={statusVar[n.status]}>{kindLabel[n.kind]}</text>
                <text y="34" textAnchor="middle" fontSize="8" fontFamily="JetBrains Mono" fill="var(--foreground)">{n.label}</text>
              </g>
            ))}
            {mode === "geo" && <GeoTrucks geo={geo} live={live} now={now} tab={tab} />}
            {mode === "geo" && <GeoCards geo={geo} live={live} now={now} tab={tab} />}
          </g>
          {mode === "geo" && <GeoOverview geo={geo} />}
        </svg>
        <div className="absolute right-3 top-3 flex flex-col gap-1">
          {[{ i: Plus, f: 1.3, l: "Zoom in" }, { i: Minus, f: 1 / 1.3, l: "Zoom out" }].map(({ i: I, f, l }) => (
            <Button variant="ghost" key={l} aria-label={l} onPointerDown={(e) => e.stopPropagation()} onClick={() => zoomAt(W / 2, H / 2, view.k * f)} className="glass p-2 text-primary"><I className="h-4 w-4" /></Button>
          ))}
          <Button variant="ghost" aria-label="Reset" onPointerDown={(e) => e.stopPropagation()} onClick={() => { setAnimate(true); setView({ x: 0, y: 0, k: 1 }); setTab("ALL"); }} className="glass p-2 text-primary"><RotateCcw className="h-4 w-4" /></Button>
        </div>
        {selected && (
          <aside className="glass absolute bottom-0 right-0 top-0 w-72 overflow-y-auto border-l border-border p-4 font-mono text-xs" onPointerDown={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{kindLabel[selected.kind]} · {selected.system}</div>
                <div className="mt-1 text-sm font-bold text-primary glow-cyan">{selected.id}</div>
              </div>
              <Button variant="ghost" aria-label="Close inspector" onClick={() => setSelected(null)} className="text-muted-foreground"><X className="h-4 w-4" /></Button>
            </div>
            <div className="mt-2 uppercase" style={{ color: statusVar[selected.status] }}>Status: {selected.status}</div>
            <p className="mt-2 text-muted-foreground">{selected.detail}</p>
            {selectedState && (
              <div className="mt-4 space-y-2 border-t border-border pt-3">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Live telemetry</div>
                <div className="flex justify-between"><span className="text-muted-foreground">Tank level</span><span className={lvl >= thresholds.warning ? "text-warning" : "text-ok"}>{lvl.toFixed(2)}%</span></div>
                <div className="h-2 overflow-hidden rounded bg-muted"><div className={`h-full ${lvl >= thresholds.shutdown ? "bg-destructive" : lvl >= thresholds.warning ? "bg-warning" : "bg-ok"}`} style={{ width: `${Math.min(100, Math.max(0, lvl))}%` }} /></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Pump flow</span><span>{bpd(selectedState.pumpFlowBpd)} bpd</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Inflow</span><span>{bpd(selectedState.inflowBpd)} bpd</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Received</span><span>{bpd(selectedState.receiveFlowBpd)} bpd</span></div>
                {selectedLogistics && <div className="flex justify-between"><span className="text-muted-foreground">Fleet arrival</span><span className="text-accent">{selectedLogistics.responseMin} min · cycle {selectedLogistics.cycleMin} min</span></div>}
              </div>
            )}
          </aside>
        )}
      </div>
    </main>
    </>
  );
}

/** Honeycomb: every cell near a system glows in its colour (pulsing red if a pump there has failed). */
function GeoHoneycomb({ geo, tab }: { geo: GeoModel; tab: string }) {
  return <g aria-hidden>
    {geo.hexes.map((h, i) => {
      const own = h.system !== null && (tab === "ALL" || h.system === tab);
      const color = h.failing ? "var(--destructive)" : h.system ? geo.systemColor[h.system] : "var(--primary)";
      return <polygon key={i} points={hexPoints(h.cx, h.cy, geo.hexR - 1)}
        fill={own ? color : "none"} fillOpacity={own ? 0.04 + 0.2 * h.intensity : 0}
        stroke={own ? color : "var(--primary)"} strokeOpacity={own ? 0.18 + 0.4 * h.intensity : 0.07} strokeWidth="1"
        className={own && h.failing && h.intensity > 0.25 ? "animate-pulse-glow" : undefined} />;
    })}
  </g>;
}

/** Truck routes: each system's truck yard to each of its facilities. */
function GeoRoutes({ geo, tab }: { geo: GeoModel; tab: string }) {
  return <g aria-hidden>
    {geo.routes.filter((r) => tab === "ALL" || r.system === tab).map((r) => (
      <line key={r.id} x1={r.from.x} y1={r.from.y} x2={r.to.x} y2={r.to.y} stroke={geo.systemColor[r.system]} strokeOpacity="0.45" strokeWidth="1.2" strokeDasharray="2 5" />
    ))}
  </g>;
}

/** Dispatched trucks (approved plans) moving yard -> facility; hauling trucks pulse at the facility. */
function GeoTrucks({ geo, live, now, tab }: { geo: GeoModel; live: LiveData; now: number; tab: string }) {
  const trucks = liveFleets(live).filter((f) => tab === "ALL" || f.id === tab).flatMap((f) =>
    fleetTrucks(live, f, now).filter((t) => t.status !== "Standby").map((t) => ({ ...t, system: f.id })));
  return <g>
    {trucks.map((t, i) => {
      const r = geo.routes.find((x) => x.facilityId === t.facility);
      if (!r) return null;
      const span = Math.max(1, (t.eta ?? now) - (t.dispatch ?? now));
      const frac = t.status === "En route" ? Math.min(1, Math.max(0, (now - (t.dispatch ?? now)) / span)) : 1;
      const x = r.from.x + (r.to.x - r.from.x) * frac;
      const y = r.from.y + (r.to.y - r.from.y) * frac;
      const off = t.status === "Hauling" ? (i % 2 ? 10 : -10) : 0;
      return <g key={t.unit} transform={`translate(${x + off} ${y - 16})`} className={t.status === "Hauling" ? "animate-pulse-glow" : undefined} style={{ transition: "transform 1s linear" }}>
        <title>{`${t.unit} · ${t.status} · ${t.facility}`}</title>
        <circle r="11" fill="var(--background)" stroke="var(--accent)" strokeWidth="1.5" filter="url(#glow)" />
        <Truck x={-7} y={-7} width={14} height={14} color="var(--accent)" />
      </g>;
    })}
  </g>;
}

/** One card per system (alerts, trucks free, revenue at risk), linked to its cluster. */
function GeoCards({ geo, live, now, tab }: { geo: GeoModel; live: LiveData; now: number; tab: string }) {
  const fleets = liveFleets(live);
  const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  return <g>
    {geo.cards.filter((c) => tab === "ALL" || c.system === tab).map((c) => {
      const ongoing = live.events.filter((e) => e.systemId === c.system && e.status === "ongoing");
      const failures = ongoing.filter((e) => e.category === "pump_failure");
      const atRisk = failures.reduce((a, e) => a + e.lostRevenuePerHour, 0);
      const fleet = fleets.find((f) => f.id === c.system);
      const free = fleet ? fleetTrucks(live, fleet, now).filter((t) => t.status === "Standby").length : 0;
      const color = failures.length ? "var(--destructive)" : geo.systemColor[c.system];
      const k = 14; // corner cut: flat-sided hexagon card
      const pts = `${c.x + k},${c.y} ${c.x + c.w - k},${c.y} ${c.x + c.w},${c.y + c.h / 2} ${c.x + c.w - k},${c.y + c.h} ${c.x + k},${c.y + c.h} ${c.x},${c.y + c.h / 2}`;
      return <g key={c.system}>
        <line x1={c.attach.x} y1={c.attach.y} x2={c.anchor.x} y2={c.anchor.y} stroke={color} strokeOpacity="0.6" strokeWidth="1" />
        <circle cx={c.anchor.x} cy={c.anchor.y} r="2.5" fill={color} />
        <polygon points={pts} fill="oklch(0.17 0.03 290 / 0.92)" stroke={color} strokeWidth="1.2" filter="url(#glow)" />
        <text x={c.x + c.w / 2} y={c.y + 20} textAnchor="middle" fontSize="12" fontWeight="bold" fontFamily="JetBrains Mono" fill={color}>SYSTEM {c.system}</text>
        <text x={c.x + c.w / 2} y={c.y + 37} textAnchor="middle" fontSize="9.5" fontFamily="JetBrains Mono" fill={ongoing.length ? "var(--destructive)" : "var(--ok)"}>{ongoing.length ? `${ongoing.length} alert${ongoing.length > 1 ? "s" : ""}` : "All clear"}</text>
        <text x={c.x + c.w / 2} y={c.y + 52} textAnchor="middle" fontSize="9.5" fontFamily="JetBrains Mono" fill="var(--muted-foreground)">{free}/{fleet?.trucks ?? 0} trucks free</text>
        <text x={c.x + c.w / 2} y={c.y + 67} textAnchor="middle" fontSize="9.5" fontFamily="JetBrains Mono" fill={atRisk ? "var(--warning)" : "var(--muted-foreground)"}>{atRisk ? `${usd(atRisk)}/h at risk` : "No revenue at risk"}</text>
      </g>;
    })}
  </g>;
}

/** True-scale overview (fixed in the corner, not affected by zoom). */
function GeoOverview({ geo }: { geo: GeoModel }) {
  const o = geo.overview;
  if (!o.w) return null;
  return <g aria-label="True-scale overview">
    <rect x={o.x} y={o.y} width={o.w} height={o.h} rx="6" fill="oklch(0.15 0.03 290 / 0.92)" stroke="var(--border)" />
    <text x={o.x + 8} y={o.y + 13} fontSize="8.5" fontFamily="JetBrains Mono" fill="var(--muted-foreground)">TRUE SCALE{geo.compression < 0.99 ? ` · map spacing ×${geo.compression.toFixed(2)}` : ""}</text>
    {o.dots.map((d, i) => d.kind === "yard"
      ? <rect key={i} x={d.x - 2} y={d.y - 2} width="4" height="4" fill="none" stroke={geo.systemColor[d.system]} strokeWidth="0.8" />
      : <circle key={i} cx={d.x} cy={d.y} r={d.kind === "disposal" ? 1.8 : 2.4} fill={d.status === "fail" ? "var(--destructive)" : d.status === "warn" ? "var(--warning)" : geo.systemColor[d.system]} />)}
    {o.labels.map((l) => <text key={l.system} x={l.x} y={l.y - 7} textAnchor="middle" fontSize="8" fontFamily="JetBrains Mono" fill={geo.systemColor[l.system]}>{l.system}</text>)}
  </g>;
}
