// Geographic map layout ("beehive" view). Pure: everything comes from the live network rows, so it
// works for any dataset (the judging network included).
//  - Compressed geography: each system keeps its real shape (facilities, disposal site, truck yard)
//    and its real direction from the others; only the empty distance BETWEEN systems is shrunk,
//    just enough that clusters don't overlap. A true-scale overview is returned for an inset.
//  - Honeycomb: a hexagon grid over the canvas; cells near a system glow in its colour, fading with
//    distance (cells of a system with a failing pump are flagged so the UI can pulse them red).
//  - Truck routes: truck yard -> each facility.
//  - System cards: one per system, placed in the emptiest nearby spot, with a leader line.
import type { LiveData } from './store';
import type { MapEdge, MapNode } from './derive';

export interface Pt {
  x: number;
  y: number;
}
export interface HexCell {
  cx: number;
  cy: number;
  /** owning system, null = background honeycomb */
  system: string | null;
  /** 0..1 glow strength */
  intensity: number;
  /** owning system has an ongoing pump failure */
  failing: boolean;
}
export interface Route {
  id: string;
  system: string;
  facilityId: string;
  from: Pt; // truck yard
  to: Pt; // facility
}
export interface SystemCard {
  system: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** where the leader line meets the cluster */
  anchor: Pt;
  /** card edge point the leader line starts from */
  attach: Pt;
}
export interface Overview {
  x: number;
  y: number;
  w: number;
  h: number;
  dots: { x: number; y: number; system: string; kind: MapNode['kind']; status: MapNode['status'] }[];
  labels: { x: number; y: number; system: string }[];
}
export interface GeoModel {
  nodes: MapNode[];
  edges: MapEdge[];
  routes: Route[];
  hexes: HexCell[];
  hexR: number;
  cards: SystemCard[];
  overview: Overview;
  systemColor: Record<string, string>;
  /** 1 = true scale; smaller = how much the space between systems was compressed */
  compression: number;
}

/** system colours from the console theme (cycled) */
export const SYSTEM_PALETTE = [
  'oklch(0.82 0.13 200)', // cyan (primary)
  'oklch(0.68 0.27 330)', // magenta (accent)
  'oklch(0.72 0.17 290)', // violet
  'oklch(0.8 0.14 170)', // teal
  'oklch(0.75 0.15 250)', // blue
  'oklch(0.86 0.15 115)', // lime
];

export const HEX_R = 16;
const CARD_W = 156;
const CARD_H = 78;

/** pointy-top hexagon points around (cx, cy) */
export function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (60 * k - 30);
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

interface RawPt {
  id: string;
  system: string;
  kind: MapNode['kind'];
  lat: number;
  lon: number;
}

export function geoLayout(live: LiveData, schematicNodes: MapNode[], schematicEdges: MapEdge[], W: number, H: number): GeoModel {
  const systems = live.systems.map((s) => s.systemId);
  const systemColor = Object.fromEntries(systems.map((s, i) => [s, SYSTEM_PALETTE[i % SYSTEM_PALETTE.length]!]));
  const failingSystems = new Set(live.events.filter((e) => e.status === 'ongoing' && e.category === 'pump_failure').map((e) => e.systemId));

  // raw geographic points per system
  const raw: RawPt[] = [];
  for (const s of live.systems) {
    raw.push({ id: s.disposalId, system: s.systemId, kind: 'disposal', lat: s.disposalLat, lon: s.disposalLon });
    raw.push({ id: `${s.systemId}_TRUCK_YARD`, system: s.systemId, kind: 'yard', lat: s.yardLat, lon: s.yardLon });
    for (const f of live.facilities.filter((x) => x.systemId === s.systemId)) raw.push({ id: f.facilityId, system: s.systemId, kind: 'facility', lat: f.lat, lon: f.lon });
  }
  const empty: GeoModel = { nodes: [], edges: [], routes: [], hexes: [], hexR: HEX_R, cards: [], overview: { x: 0, y: 0, w: 0, h: 0, dots: [], labels: [] }, systemColor, compression: 1 };
  if (!raw.length) return empty;

  // local equirectangular projection (degrees; x scaled by cos(lat))
  const lat0 = (raw.reduce((a, p) => a + p.lat, 0) / raw.length) * (Math.PI / 180);
  const proj = (p: RawPt): Pt => ({ x: p.lon * Math.cos(lat0), y: -p.lat });
  const P = new Map(raw.map((p) => [p.id, proj(p)]));

  // clusters: centroid + radius
  const cl = systems.map((sys) => {
    const pts = raw.filter((p) => p.system === sys).map((p) => P.get(p.id)!);
    const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    const r = Math.max(1e-6, ...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));
    return { sys, c, r };
  });
  const g = { x: cl.reduce((a, k) => a + k.c.x, 0) / cl.length, y: cl.reduce((a, k) => a + k.c.y, 0) / cl.length };
  const meanR = cl.reduce((a, k) => a + k.r, 0) / cl.length;
  // smallest compression that keeps clusters apart (gap ~ 60% of a mean cluster radius)
  let C = cl.length > 1 ? 0 : 1;
  for (let i = 0; i < cl.length; i++)
    for (let j = i + 1; j < cl.length; j++) {
      const d = Math.hypot(cl[i]!.c.x - cl[j]!.c.x, cl[i]!.c.y - cl[j]!.c.y);
      if (d > 0) C = Math.max(C, (cl[i]!.r + cl[j]!.r + 0.6 * meanR) / d);
    }
  C = Math.min(1, Math.max(0.15, C));
  const clusterOf = new Map(cl.map((k) => [k.sys, k]));
  const compressed = new Map(
    raw.map((p) => {
      const k = clusterOf.get(p.system)!;
      const q = P.get(p.id)!;
      return [p.id, { x: g.x + C * (k.c.x - g.x) + (q.x - k.c.x), y: g.y + C * (k.c.y - g.y) + (q.y - k.c.y) }];
    }),
  );

  // fit into the canvas, leaving room around clusters for the system cards
  const margin = 130;
  const xs = [...compressed.values()].map((p) => p.x);
  const ys = [...compressed.values()].map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const bw = Math.max(1e-6, Math.max(...xs) - minX);
  const bh = Math.max(1e-6, Math.max(...ys) - minY);
  const scale = Math.min((W - 2 * margin) / bw, (H - 2 * margin) / bh);
  const ox = (W - bw * scale) / 2;
  const oy = (H - bh * scale) / 2;
  const toCanvas = (p: Pt): Pt => ({ x: ox + (p.x - minX) * scale, y: oy + (p.y - minY) * scale });
  const pos = new Map([...compressed.entries()].map(([id, p]) => [id, toCanvas(p)]));

  // nodes (statuses from the schematic model, which reads live events/readings)
  const nodes: MapNode[] = [];
  for (const p of raw) {
    const at = pos.get(p.id)!;
    if (p.kind === 'yard') {
      const s = live.systems.find((x) => x.systemId === p.system)!;
      const trucks = live.opsSystems.find((o) => o.systemId === p.system)?.fleetSize ?? 0;
      nodes.push({ id: p.id, label: `${p.system} YARD`, kind: 'yard', x: at.x, y: at.y, status: 'ok', detail: `${trucks} trucks · ${s.yardLat}, ${s.yardLon}`, system: p.system });
      continue;
    }
    const base = schematicNodes.find((n) => n.id === p.id);
    if (!base) continue;
    let status = base.status;
    if (p.kind === 'facility') {
      const f = live.facilities.find((x) => x.facilityId === p.id);
      const pump = f ? schematicNodes.find((n) => n.id === f.pumpId) : undefined;
      if (pump && pump.status !== 'ok') status = pump.status;
    }
    nodes.push({ ...base, x: at.x, y: at.y, status });
  }
  const edges: MapEdge[] = live.facilities.map((f) => {
    const sys = live.systems.find((s) => s.systemId === f.systemId)!;
    const pipe = schematicEdges.find((e) => e.id === f.pipelineId);
    return { id: f.pipelineId, from: f.facilityId, to: sys.disposalId, failing: pipe?.failing ?? false, system: f.systemId };
  });
  const routes: Route[] = live.facilities.map((f) => ({
    id: `route-${f.facilityId}`,
    system: f.systemId,
    facilityId: f.facilityId,
    from: pos.get(`${f.systemId}_TRUCK_YARD`)!,
    to: pos.get(f.facilityId)!,
  }));

  // cluster geometry in canvas units
  const clusterPx = cl.map((k) => {
    const ids = raw.filter((p) => p.system === k.sys).map((p) => p.id);
    const pts = ids.map((id) => pos.get(id)!);
    const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    return { sys: k.sys, c, r: Math.max(24, ...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y))), pts };
  });

  // honeycomb: owner = system with the nearest node within reach
  const hexes: HexCell[] = [];
  const dx = Math.sqrt(3) * HEX_R;
  const dy = 1.5 * HEX_R;
  const reach = Math.max(70, 4.5 * HEX_R);
  for (let row = 0, cy = 0; cy <= H + HEX_R; row++, cy += dy) {
    for (let cx = row % 2 ? dx / 2 : 0; cx <= W + dx; cx += dx) {
      let best: string | null = null;
      let bestD = Infinity;
      for (const k of clusterPx) {
        for (const p of k.pts) {
          const d = Math.hypot(p.x - cx, p.y - cy);
          if (d < bestD) {
            bestD = d;
            best = k.sys;
          }
        }
      }
      const own = bestD < reach ? best : null;
      hexes.push({ cx, cy, system: own, intensity: own ? Math.pow(1 - bestD / reach, 1.2) : 0, failing: own ? failingSystems.has(own) : false });
    }
  }

  // system cards: try 16 directions x 4 distances; avoid nodes, routes, other cards, the inset and the edges.
  // The leader line runs to the system's node nearest the card (not the cluster centre, which can be empty space).
  const NODE_R = 24;
  const allNodes = clusterPx.flatMap((k) => k.pts);
  const routeDots = routes.flatMap((r) => {
    const n = Math.max(1, Math.floor(Math.hypot(r.to.x - r.from.x, r.to.y - r.from.y) / 14));
    return Array.from({ length: n + 1 }, (_, i) => ({ x: r.from.x + ((r.to.x - r.from.x) * i) / n, y: r.from.y + ((r.to.y - r.from.y) * i) / n }));
  });
  const ovW = 210;
  const ovH = 140;
  const inset = { x: 14, y: H - ovH - 14, w: ovW, h: ovH }; // the true-scale overview, drawn below
  const cards: SystemCard[] = [];
  for (const k of clusterPx) {
    let bestCard: SystemCard | null = null;
    let bestScore = Infinity;
    const outward = Math.atan2(k.c.y - H / 2, k.c.x - W / 2);
    for (const dist of [70, 110, 160, 220]) {
      for (let a = 0; a < 16; a++) {
        const ang = (a * Math.PI) / 8;
        const cx = k.c.x + Math.cos(ang) * dist;
        const cy = k.c.y + Math.sin(ang) * dist;
        const card = { x: cx - CARD_W / 2, y: cy - CARD_H / 2, w: CARD_W, h: CARD_H };
        let score = 0;
        for (const n of allNodes) score += circleRectOverlap(n, NODE_R, card) * 6;
        for (const d of routeDots) score += circleRectOverlap(d, 6, card) * 3;
        for (const c of cards) score += rectOverlap({ x: card.x - 8, y: card.y - 8, w: card.w + 16, h: card.h + 16 }, c) * 20;
        score += rectOverlap({ x: inset.x - 8, y: inset.y - 8, w: inset.w + 16, h: inset.h + 16 }, card) * 20;
        score += outOfBounds(card, W, H) * 20;
        score += (1 - Math.cos(ang - outward)) * 15; // prefer pointing away from the middle
        score += dist / 10; // and staying close to the cluster
        if (score < bestScore) {
          bestScore = score;
          const near = k.pts.reduce((b, p) => (Math.hypot(p.x - cx, p.y - cy) < Math.hypot(b.x - cx, b.y - cy) ? p : b));
          const len = Math.hypot(cx - near.x, cy - near.y) || 1;
          const anchor = { x: near.x + ((cx - near.x) / len) * 14, y: near.y + ((cy - near.y) / len) * 14 };
          bestCard = { system: k.sys, ...card, anchor, attach: rectEdgePoint(card, near) };
        }
      }
    }
    if (bestCard) cards.push(bestCard);
  }

  // true-scale overview inset (bottom-left)
  const ov = inset;
  const tx = [...P.values()].map((p) => p.x);
  const ty = [...P.values()].map((p) => p.y);
  const tMinX = Math.min(...tx);
  const tMinY = Math.min(...ty);
  const tbw = Math.max(1e-6, Math.max(...tx) - tMinX);
  const tbh = Math.max(1e-6, Math.max(...ty) - tMinY);
  const ts = Math.min((ovW - 24) / tbw, (ovH - 30) / tbh);
  const tox = ov.x + (ovW - tbw * ts) / 2;
  const toy = ov.y + 18 + (ovH - 24 - tbh * ts) / 2;
  const ovPt = (p: Pt) => ({ x: tox + (p.x - tMinX) * ts, y: toy + (p.y - tMinY) * ts });
  const overview: Overview = {
    ...ov,
    dots: raw.map((p) => {
      const n = nodes.find((x) => x.id === p.id);
      return { ...ovPt(P.get(p.id)!), system: p.system, kind: p.kind, status: n?.status ?? 'ok' };
    }),
    labels: cl.map((k) => ({ ...ovPt(k.c), system: k.sys })),
  };

  return { nodes, edges, routes, hexes, hexR: HEX_R, cards, overview, systemColor, compression: C };
}

type Rect = { x: number; y: number; w: number; h: number };
function rectOverlap(a: Rect, b: Rect) {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (w * h) / 100;
}
function circleRectOverlap(c: Pt, r: number, rect: Rect) {
  return rectOverlap({ x: c.x - r, y: c.y - r, w: 2 * r, h: 2 * r }, rect);
}
function outOfBounds(r: Rect, W: number, H: number) {
  return (Math.max(0, -r.x) + Math.max(0, r.x + r.w - W) + Math.max(0, -r.y) + Math.max(0, r.y + r.h - H)) * 2;
}
/** point on the rectangle's border towards target */
function rectEdgePoint(r: Rect, target: Pt): Pt {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const s = Math.min(Math.abs((r.w / 2) / (dx || 1e-9)), Math.abs((r.h / 2) / (dy || 1e-9)));
  return { x: cx + dx * s, y: cy + dy * s };
}
