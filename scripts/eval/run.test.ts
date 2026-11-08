// CI check: the full eval scoreboard on the real core (detector, countdown, planner) must pass
// in --strict mode. Skipped when the datasets are not present (data/ is gitignored).
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DATA = resolve(__dirname, '../../data/eog');
const hasData = existsSync(join(DATA, 'full_week', 'answer_key.json'));

describe.skipIf(!hasData)('eval scoreboard (real core)', () => {
  it('passes every check in strict mode', async () => {
    const { main } = await import('./run');
    const res = main(['--data', DATA, '--sweep-min', '120', '--strict'], process.env.EVAL_PRINT ? console.log : () => {});
    expect(res.text).toContain('full_week');
    expect(res.text).not.toContain('not implemented');
    expect(res.summary.fail).toBe(0);
    expect(res.exitCode).toBe(0);
  }, 120_000);
});
