// Number verifier: every dollar figure, time, duration, percentage, count and volume in
// LLM-written text must be backed by a fact from that run's tool results.
// Pure TS, no Spacetime imports.

export type ClaimKind = 'dollars' | 'hours' | 'minutes' | 'percent' | 'count' | 'clock' | 'volume';

export interface Claim {
  kind: ClaimKind;
  value: number; // dollars | hours | minutes | percent | count | minutes-of-day (clock) | bbl
  text: string; // the matched text
  decimals: number; // decimals as written (for rounding tolerance)
}

export interface VerifyResult {
  ok: boolean;
  claims: Claim[];
  unsupported: Claim[];
}

/** Allowed facts, grouped by kind. Build with FactSet.add* or collectFacts(). */
export class FactSet {
  dollars: number[] = [];
  hours: number[] = [];
  minutes: number[] = [];
  percent: number[] = [];
  count: number[] = [];
  /** unix seconds; compared as UTC minutes of day */
  timesUnix: number[] = [];
  volume: number[] = [];

  addDollars(...v: number[]) { push(this.dollars, v); return this; }
  addHours(...v: number[]) {
    push(this.hours, v);
    push(this.minutes, v.map((h) => h * 60));
    return this;
  }
  addMinutes(...v: number[]) {
    push(this.minutes, v);
    push(this.hours, v.map((m) => m / 60));
    return this;
  }
  addPercent(...v: number[]) { push(this.percent, v); return this; }
  addCount(...v: number[]) { push(this.count, v); return this; }
  addTime(...unix: number[]) { push(this.timesUnix, unix); return this; }
  addVolume(...v: number[]) { push(this.volume, v); return this; }
  merge(o: FactSet) {
    this.dollars.push(...o.dollars);
    this.hours.push(...o.hours);
    this.minutes.push(...o.minutes);
    this.percent.push(...o.percent);
    this.count.push(...o.count);
    this.timesUnix.push(...o.timesUnix);
    this.volume.push(...o.volume);
    return this;
  }
}

function push(dst: number[], v: number[]) {
  for (const x of v) if (typeof x === 'number' && Number.isFinite(x)) dst.push(x);
}

/**
 * Walk tool results and collect facts by key name (camelCase or snake_case):
 *  cost/usd/revenue/savings/delta/price -> dollars; *Unix/*_unix/at -> clock times;
 *  hours, hoursToLimit..., p10/p50/p90 -> hours; *Min/minutes -> minutes; *Pct/percent/level -> percent;
 *  trucks/trips/count/wells(n)/fleet/available -> counts; bbl/volume -> volume.
 * Arrays of ids also contribute their length as a count.
 */
export function collectFacts(...values: unknown[]): FactSet {
  const f = new FactSet();
  const visit = (v: unknown, key: string, depth: number) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'number') return classify(f, key, v);
    if (typeof v === 'bigint') return classify(f, key, Number(v));
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => typeof x === 'string')) f.addCount(v.length);
      // long numeric traces (level traces) are not quotable facts, except their max
      if (v.length > 50 && v.every((x) => typeof x === 'number')) {
        const nums = v as number[];
        classify(f, key, Math.max(...nums));
        return;
      }
      for (const x of v) visit(x, key, depth + 1);
      return;
    }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v as object)) visit(x, k, depth + 1);
  };
  for (const v of values) visit(v, '', 0);
  return f;
}

function classify(f: FactSet, keyRaw: string, v: number) {
  const k = keyRaw.toLowerCase().replace(/_/g, '');
  if (/unix$|^at$|timestamp/.test(k)) return f.addTime(v);
  if (/cost|usd|revenue|savings|delta|price|dollars|pertrip|loss/.test(k)) return f.addDollars(v);
  if (/hours|hourstolimit|^p10$|^p50$|^p90$|horizonh|remainingh|^h$/.test(k)) return f.addHours(v);
  if (/min$|minutes|mins$/.test(k)) return f.addMinutes(v);
  if (/pct|percent|level/.test(k)) return f.addPercent(v);
  if (/bbl|volume|barrels/.test(k)) return f.addVolume(v);
  if (/truck|trip|count|wells|fleet|available|rank|steps|n$/.test(k)) return f.addCount(v);
  // unknown key: allow as a count if it is a small integer (e.g. totals), else ignore
  if (Number.isInteger(v) && v >= 0 && v <= 50) f.addCount(v);
}

const WORD_NUM: Record<string, number> = {
  no: 0, zero: 0, one: 1, a: 1, an: 1, single: 1, two: 2, both: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function decimalsOf(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
const num = (s: string) => Number(s.replace(/,/g, ''));

/** Extract numeric claims from text. Identifiers like S2_WELL_C1 / EVENT_12 are ignored. */
export function extractClaims(textRaw: string): Claim[] {
  // blank out identifiers and ISO dates so their digits aren't read as claims
  let text = textRaw
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+\b/g, (m) => ' '.repeat(m.length))
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => ' '.repeat(m.length))
    .replace(/\b\d{2}-\d{2}(?=\s+\d{1,2}:\d{2})/g, (m) => ' '.repeat(m.length)); // "10-08 12:00"
  const claims: Claim[] = [];
  const take = (re: RegExp, fn: (m: RegExpExecArray) => Claim | null) => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const c = fn(m);
      if (c) claims.push(c);
      // mask so later patterns don't re-read the same digits
      text = text.slice(0, m.index) + ' '.repeat(m[0].length) + text.slice(m.index + m[0].length);
      re.lastIndex = m.index + m[0].length;
    }
  };
  // $1,234.56 / $3.1k
  take(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*([kK])?\b/g, (m) => {
    const v = num(m[1]) * (m[2] ? 1000 : 1);
    return { kind: 'dollars', value: v, text: m[0].trim(), decimals: m[2] ? decimalsOf(m[1]) - 3 : decimalsOf(m[1]) };
  });
  // HH:MM (optionally UTC)
  take(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?:\s*UTC)?/g, (m) => ({
    kind: 'clock', value: Number(m[1]) * 60 + Number(m[2]), text: m[0].trim(), decimals: 0,
  }));
  // 1 h 35 min / 1h35
  take(/\b(\d+)\s*(?:h|hr|hrs|hours?)\s*(?:and\s*)?(\d+)\s*(?:m|min|mins|minutes)\b/gi, (m) => ({
    kind: 'minutes', value: Number(m[1]) * 60 + Number(m[2]), text: m[0].trim(), decimals: 0,
  }));
  take(/\+?\b(\d+(?:\.\d+)?)\s*(?:min|mins|minutes?)\b/gi, (m) => ({ kind: 'minutes', value: num(m[1]), text: m[0].trim(), decimals: decimalsOf(m[1]) }));
  take(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/gi, (m) => ({ kind: 'hours', value: num(m[1]), text: m[0].trim(), decimals: decimalsOf(m[1]) }));
  take(/\b(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi, (m) => ({ kind: 'percent', value: num(m[1]), text: m[0].trim(), decimals: decimalsOf(m[1]) }));
  take(/\b(\d[\d,]*(?:\.\d+)?)\s*(?:bbl|barrels?)\b/gi, (m) => ({ kind: 'volume', value: num(m[1]), text: m[0].trim(), decimals: decimalsOf(m[1]) }));
  // counts: "2 trucks", "one trip", "two wells"
  take(/\b(\d+|no|zero|one|a|an|single|two|both|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:more|extra|additional|free|available|emergency|of\s+\d+)\s+)?(trucks?|trips?|wells?|truckloads?|loads?)\b/gi, (m) => {
    const w = m[1].toLowerCase();
    const v = /^\d+$/.test(w) ? Number(w) : WORD_NUM[w];
    if (v === undefined) return null;
    // "a truck" / "an" are too generic to check strictly
    if (w === 'a' || w === 'an') return null;
    return { kind: 'count', value: v, text: m[0].trim(), decimals: 0 };
  });
  return claims;
}

function roundTo(x: number, d: number) {
  if (d <= 0) {
    const p = Math.pow(10, -d);
    return Math.round(x / p) * p;
  }
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}

function close(c: Claim, f: number): boolean {
  const x = c.value;
  switch (c.kind) {
    case 'dollars':
      return Math.abs(x - f) <= Math.max(1, 0.005 * Math.abs(f)) || Math.abs(roundTo(f, c.decimals) - x) < 1e-6;
    case 'hours':
      return Math.abs(x - f) <= 0.05 || Math.abs(roundTo(f, c.decimals) - x) < 1e-9;
    case 'minutes':
      return Math.abs(x - f) <= 1 || Math.abs(roundTo(f, c.decimals) - x) < 1e-9;
    case 'percent':
      return Math.abs(x - f) <= 0.15 || Math.abs(roundTo(f, c.decimals) - x) < 1e-9;
    case 'volume':
      return Math.abs(x - f) <= Math.max(1, 0.01 * Math.abs(f));
    case 'count':
      return x === f;
    default:
      return false;
  }
}

export function verifyText(text: string, facts: FactSet): VerifyResult {
  const claims = extractClaims(text);
  const unsupported: Claim[] = [];
  const clockFacts = facts.timesUnix.map((u) => Math.round(((u % 86400) + 86400) % 86400 / 60) % 1440);
  for (const c of claims) {
    let ok: boolean;
    if (c.kind === 'clock') {
      ok = clockFacts.some((m) => Math.min(Math.abs(m - c.value), 1440 - Math.abs(m - c.value)) <= 1);
    } else if (c.kind === 'count') {
      ok = facts.count.some((f) => close(c, f)) || (c.value === 0 && true);
    } else {
      const pool =
        c.kind === 'dollars' ? facts.dollars :
        c.kind === 'hours' ? facts.hours :
        c.kind === 'minutes' ? facts.minutes :
        c.kind === 'percent' ? facts.percent : facts.volume;
      ok = pool.some((f) => close(c, f));
    }
    if (!ok) unsupported.push(c);
  }
  return { ok: unsupported.length === 0, claims, unsupported };
}

export function describeUnsupported(r: VerifyResult): string {
  return r.unsupported.map((c) => `"${c.text}"`).join(', ');
}

/** Facts quoted from trusted tool text (e.g. detector evidence strings, planner summaries). */
export function factsFromText(...texts: string[]): FactSet {
  const f = new FactSet();
  for (const t of texts) {
    for (const c of extractClaims(t)) {
      if (c.kind === 'dollars') f.addDollars(c.value);
      else if (c.kind === 'hours') f.addHours(c.value);
      else if (c.kind === 'minutes') f.addMinutes(c.value);
      else if (c.kind === 'percent') f.addPercent(c.value);
      else if (c.kind === 'count') f.addCount(c.value);
      else if (c.kind === 'volume') f.addVolume(c.value);
      else if (c.kind === 'clock') f.addTime(c.value * 60); // minutes of day -> seconds of day (UTC)
    }
  }
  return f;
}
