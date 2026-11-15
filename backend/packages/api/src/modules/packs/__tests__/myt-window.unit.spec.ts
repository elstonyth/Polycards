import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePeriod } from '../myt-window';

// The admin assistant's resolvePeriod against the desk bots' table
// (tools/desk-reports/periods.fixture.json, which periods.test.mjs runs
// against periods.mjs): the two copies resolve every period alike.
type Fixture = {
  now: string;
  windows: {
    period: string;
    now?: string;
    args?: { from?: string; to?: string };
    from: string | null;
    to: string | null;
    label?: string;
  }[];
  errors: { period: string; args: { from?: string; to?: string }; error: string }[];
};
const fixture: Fixture = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../../../../tools/desk-reports/periods.fixture.json'),
    'utf8',
  ),
);

describe('resolvePeriod (the shared desk fixture)', () => {
  it.each(fixture.windows.map((c) => [c.period, c] as const))(
    '%s',
    (_, c) => {
      const r = resolvePeriod(c.period, c.args ?? {}, Date.parse(c.now ?? fixture.now));
      expect([r.from, r.to]).toEqual([c.from, c.to]);
      if (c.label) expect(r.label).toBe(c.label);
    },
  );

  it.each(fixture.errors.map((c) => [c.period, c] as const))(
    '%s refuses bad input',
    (_, c) => {
      expect(() =>
        resolvePeriod(c.period, c.args, Date.parse(fixture.now)),
      ).toThrow(new RegExp(c.error));
    },
  );
});
