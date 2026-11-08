import { describe, expect, it } from 'vitest';
import { recommendFleets } from '@/lib/fleet-recommendations';

const base = [
  { id: 'S1', trucks: 2, standby: 2, failures: 1 },
  { id: 'S2', trucks: 2, standby: 0, failures: 1 },
  { id: 'S3', trucks: 3, standby: 3, failures: 1 },
];

describe('fleet recommendations', () => {
  it('suggests borrowing a truck when a fleet has none on standby', () => {
    const t = recommendFleets(base).filter(r => r.kind === 'temporary');
    expect(t).toHaveLength(1);
    expect(t[0]?.to).toBe('S2');
  });
  it('never borrows from a fleet that would be left with no standby truck', () => {
    const r = recommendFleets([{ id: 'S1', trucks: 2, standby: 1, failures: 0 }, { id: 'S2', trucks: 2, standby: 0, failures: 0 }]);
    expect(r.filter(x => x.kind === 'temporary')).toHaveLength(0);
  });
  it('suggests a permanent move when failures per truck are at least double', () => {
    const r = recommendFleets([{ id: 'S1', trucks: 2, standby: 2, failures: 8 }, { id: 'S3', trucks: 3, standby: 3, failures: 1 }]);
    expect(r.find(x => x.kind === 'long_term')).toMatchObject({ from: 'S3', to: 'S1' });
  });
  it('makes no permanent suggestion when load is balanced', () => {
    expect(recommendFleets(base).some(r => r.kind === 'long_term')).toBe(false);
  });
});
