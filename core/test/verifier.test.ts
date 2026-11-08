import { describe, expect, it } from 'vitest';
import { collectFacts, extractClaims, FactSet, verifyText } from '../src/verifier';

const T0 = Date.UTC(2026, 9, 8, 12, 0) / 1000; // 12:00 UTC

describe('extractClaims', () => {
  it('reads dollars, times, durations, percents, counts and ignores identifiers', () => {
    const c = extractClaims('Send 1 truck, 1 trip to S2_FACILITY_B ($905). Shut in S2_WELL_C1 at +46 min. Tank at 78.6%, trips in 1.42 h at 13:25 UTC. Saves $9,159.');
    const kinds = c.map((x) => `${x.kind}:${x.value}`);
    expect(kinds).toEqual(expect.arrayContaining(['dollars:905', 'dollars:9159', 'minutes:46', 'percent:78.6', 'hours:1.42', 'clock:805', 'count:1']));
    expect(c.some((x) => x.value === 2 && x.kind === 'count')).toBe(false); // S2 ids ignored
  });
  it('reads word counts and h+min durations', () => {
    const c = extractClaims('Two trucks, one trip each; about 1 h 35 min.');
    expect(c.map((x) => `${x.kind}:${x.value}`)).toEqual(expect.arrayContaining(['count:2', 'count:1', 'minutes:95']));
  });
  it('reads $k amounts', () => {
    expect(extractClaims('about $3.1k')[0]).toMatchObject({ kind: 'dollars', value: 3100 });
  });
});

describe('verifyText', () => {
  const facts = new FactSet()
    .addDollars(905, 3108.33, 12267)
    .addHours(1.41, 2.33)
    .addMinutes(46, 75)
    .addPercent(78.6, 92)
    .addCount(1, 2, 3)
    .addTime(T0 + 85 * 60); // 13:25

  it('accepts supported numbers, with rounding', () => {
    const r = verifyText('Plan costs $3,108 vs $12,267 if nothing is done. Tank 78.6%, shutdown 92%. ~1.4 h left (about 2 hours for C). Truck arrives in 75 min, shut-in at +46 min, at 13:25 UTC. 2 trucks, 1 trip each.', facts);
    expect(r.unsupported).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it('flags invented numbers', () => {
    const r = verifyText('This saves $10,000 and the tank trips at 14:10 in 3.5 h; send 4 trucks.', facts);
    expect(r.ok).toBe(false);
    expect(r.unsupported.map((c) => c.text)).toEqual(expect.arrayContaining(['$10,000', '14:10', '3.5 h', '4 trucks']));
  });
  it('dollar tolerance is $1 or 0.5%', () => {
    expect(verifyText('$906', facts).ok).toBe(true);
    expect(verifyText('$910', facts).ok).toBe(false);
  });
});

describe('collectFacts', () => {
  it('classifies by key name', () => {
    const f = collectFacts({ totalCost: 905, hoursToLimitP50: 1.42, levelPct: 78.6, trucks: 1, tripsAtUnix: T0, startAfterMin: 46, wells: ['W1', 'W2'] });
    expect(f.dollars).toContain(905);
    expect(f.hours).toContain(1.42);
    expect(f.percent).toContain(78.6);
    expect(f.count).toEqual(expect.arrayContaining([1, 2]));
    expect(f.timesUnix).toContain(T0);
    expect(f.minutes).toContain(46);
    expect(verifyText('trips at 12:00 UTC', f).ok).toBe(true);
  });
});
