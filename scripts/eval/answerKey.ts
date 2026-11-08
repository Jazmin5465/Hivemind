// Typed reader for answer_key.json.
// RULE: scripts/eval/ is the ONLY place in the repo allowed to read answer_key.json.
// Nothing outside scripts/eval/ may import this module (scripts/check-answer-key.sh guards app code).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventCategory, EventStatus } from '../../core/src/types';

export const ANSWER_KEY_FILE = 'answer_key.json';

export interface AnswerKeyEvent {
  id: string;
  system: string;
  facility: string;
  asset: string;
  category: EventCategory | string;
  onset: string | null;
  onsetUnix: number;
  end: string | null;
  endUnix: number | null;
  status: EventStatus | string;
  referenceActionRaw: string;
  reference: ReferenceAction;
  /** pump failures: tank level at onset */
  levelPct: number | null;
  tripsAtUnix: number | null;
  /** snapshots, ongoing pump failures only */
  levelFinalPct: number | null;
  hoursToLimitFinal: number | null;
  lostRevenuePerHour: number | null;
  order: number | null;
  /** the untouched JSON object */
  raw: Record<string, unknown>;
}

export type ReferenceKind = 'field_inspection' | 'none' | 'truck' | 'shut_in' | 'truck+shut_in' | 'unknown';

export interface ReferenceAction {
  kind: ReferenceKind;
  /** dollars; 0 for none / field_inspection; null if a cost-bearing action has no parsable $ */
  cost: number | null;
  trucks: number;
  /** trips per truck (null when the text gives a total that does not divide evenly) */
  tripsPerTruck: number | null;
  totalTrips: number;
  wells: string[];
  /** shut-in start, minutes after plan start */
  startAfterMin: number | null;
  /** "(shares S2's 2 trucks with EVENT_12, EVENT_13)" */
  sharesWith: string[];
  /** "(1 of 2 trucks free; ...)" */
  trucksFree: number | null;
  fleetSize: number | null;
  /** extra info: "peaks ~76.7%", "~94 min before the trip" */
  notes: string[];
  raw: string;
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const toNum = (s: string) => Number(s.replace(/,/g, ''));

/** Parse the free-text reference_action into a structured action. Unknown text → kind 'unknown', raw kept. */
export function parseReferenceAction(text: string | null | undefined): ReferenceAction {
  const raw = (text ?? '').trim();
  const out: ReferenceAction = {
    kind: 'unknown',
    cost: null,
    trucks: 0,
    tripsPerTruck: null,
    totalTrips: 0,
    wells: [],
    startAfterMin: null,
    sharesWith: [],
    trucksFree: null,
    fleetSize: null,
    notes: [],
    raw,
  };
  if (!raw) return out;
  const lower = raw.toLowerCase();

  // Parenthesised notes: cost, sharing, free trucks, misc.
  const parens = [...raw.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim());
  for (const p of parens) {
    const share = p.match(/shares\s+.*?(\d+)\s+trucks?\s+with\s+(.+)$/i);
    if (share) {
      out.fleetSize = Number(share[1]);
      out.sharesWith = share[2].split(/\s*(?:,|\band\b)\s*/).map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const free = p.match(/(\d+)\s+of\s+(\d+)\s+trucks?\s+free/i);
    if (free) {
      out.trucksFree = Number(free[1]);
      out.fleetSize = Number(free[2]);
      continue;
    }
    if (!/^~?\s*\$/.test(p)) out.notes.push(p);
  }
  const costM = raw.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (costM) out.cost = toNum(costM[1]);

  // Strip parentheticals to read the action itself.
  const body = raw.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const bodyLower = body.toLowerCase();

  if (/^field[_ ]inspection\b/.test(lower)) {
    out.kind = 'field_inspection';
    out.cost = out.cost ?? 0;
    return out;
  }
  if (/^(none|do nothing|nothing)\b/.test(bodyLower)) {
    out.kind = 'none';
    out.cost = out.cost ?? 0;
    return out;
  }

  // Trucks: "1 truck, 1 trip", "2 trucks, 1 trip each", "1 truck, 2 trips", "2 trucks, 3 trips"
  const truckM = body.match(/(\d+)\s+trucks?\b\s*,?\s*(?:(\d+)\s+trips?\b(\s+each)?)?/i);
  let hasTruck = false;
  if (truckM) {
    hasTruck = true;
    out.trucks = Number(truckM[1]);
    const trips = truckM[2] != null ? Number(truckM[2]) : 1;
    const each = !!truckM[3];
    if (each || out.trucks === 1) {
      out.tripsPerTruck = trips;
      out.totalTrips = trips * out.trucks;
    } else {
      // "N trucks, M trips" without "each": treat M as total trips
      out.totalTrips = trips;
      out.tripsPerTruck = trips % out.trucks === 0 ? trips / out.trucks : null;
    }
  }

  // Shut-in: "shut in S2_WELL_C1 at +46 min, ..." / "shut in A, B and C at +0 min" / "shut in X now"
  const shutIdx = body.search(/shut[\s-]?in\s+/i);
  let hasShut = false;
  if (shutIdx >= 0) {
    hasShut = true;
    let rest = body.slice(shutIdx).replace(/^shut[\s-]?in\s+/i, '');
    // asset ids start with an uppercase letter or digit (words like "at", "now" do not)
    for (;;) {
      const m = rest.match(/^([A-Z0-9][A-Za-z0-9_.-]*)/);
      if (!m) break;
      out.wells.push(m[1]);
      rest = rest.slice(m[1].length);
      const sep = rest.match(/^\s*(?:,|&|\band\b)\s*/);
      if (!sep) break;
      rest = rest.slice(sep[0].length);
    }
    const at = rest.match(/^\s*(?:at|from|after)\s+\+?\s*(\d+(?:\.\d+)?)\s*min\b/i);
    if (at) out.startAfterMin = Number(at[1]);
    else if (/^\s*(now|immediately)\b/i.test(rest)) out.startAfterMin = 0;
  }
  const tail = body.match(/~\s*(\d+)\s*min\s+before the trip/i);
  if (tail) out.notes.push(`${tail[1]} min before the trip`);

  if (hasTruck && hasShut) out.kind = 'truck+shut_in';
  else if (hasTruck) out.kind = 'truck';
  else if (hasShut) out.kind = 'shut_in';
  return out;
}

function toEvent(o: Record<string, any>): AnswerKeyEvent {
  const refRaw = typeof o.reference_action === 'string' ? o.reference_action : JSON.stringify(o.reference_action ?? '');
  return {
    id: String(o.id ?? o.event_id ?? ''),
    system: String(o.system ?? o.system_id ?? ''),
    facility: String(o.facility ?? o.facility_id ?? ''),
    asset: String(o.asset ?? o.asset_id ?? ''),
    category: String(o.category ?? ''),
    onset: strOrNull(o.onset),
    onsetUnix: Number(o.onset_unix),
    end: strOrNull(o.end),
    endUnix: numOrNull(o.end_unix),
    status: String(o.status ?? ''),
    referenceActionRaw: refRaw,
    reference: parseReferenceAction(refRaw),
    levelPct: numOrNull(o.level_pct),
    tripsAtUnix: numOrNull(o.trips_at_unix),
    levelFinalPct: numOrNull(o.level_final_pct),
    hoursToLimitFinal: numOrNull(o.hours_to_limit_final),
    lostRevenuePerHour: numOrNull(o.lost_revenue_per_hour),
    order: numOrNull(o.order),
    raw: o,
  };
}

/** Parse answer_key.json text (top-level array, or an object with an `events` array). */
export function parseAnswerKey(text: string): AnswerKeyEvent[] {
  const j = JSON.parse(text);
  const list: unknown = Array.isArray(j) ? j : j && typeof j === 'object' ? (j as any).events : null;
  if (!Array.isArray(list)) throw new Error('answer_key.json: expected an array of events (or {events: [...]})');
  return list
    .filter((e): e is Record<string, any> => !!e && typeof e === 'object')
    .map(toEvent)
    .sort((a, b) => a.onsetUnix - b.onsetUnix);
}

/** Read <dir>/answer_key.json; null if the folder has none. */
export function readAnswerKey(dir: string): AnswerKeyEvent[] | null {
  const p = join(dir, ANSWER_KEY_FILE);
  if (!existsSync(p)) return null;
  return parseAnswerKey(readFileSync(p, 'utf8'));
}
