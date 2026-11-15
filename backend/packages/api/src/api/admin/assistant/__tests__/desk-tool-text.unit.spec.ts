import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../tools';

// The admin assistant and the desk bots (tools/desk-reports/tools.mjs) call
// the same Finance routes, so they must describe them in the same words: the
// two copies had drifted (the desk's net left out coin flip payouts).
const desk = readFileSync(
  join(__dirname, '../../../../../../../../tools/desk-reports/tools.mjs'),
  'utf8',
);

describe('Finance tool text matches the desk bots', () => {
  it.each(['economy', 'daily_economy', 'payments', 'pack_sales'])(
    '%s',
    (name) => {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(desk).toContain(tool!.description);
    },
  );

  it('the period argument', () => {
    const economy = TOOLS.find((t) => t.name === 'economy')!;
    const period = (
      economy.parameters as { properties: { period: { description: string } } }
    ).properties.period.description;
    expect(desk).toContain(period);
    expect(period).toContain('not the dashboard 7d and 30d tabs');
  });
});
