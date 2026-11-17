import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../tools';

// The admin assistant and the desk bots (tools/desk-reports/tools.mjs) call
// the same report routes. Where they mean the same thing they must say it in
// the same words: the two copies had drifted (the desk's net left out coin
// flip payouts). The two cannot share one file at run time (the backend image
// builds from backend/ only, and install.mjs copies the desk server to the
// Hermes folder), so this spec is the link: every assistant tool a desk bot
// also has is either worded the same or listed as the assistant's own words.
const desk = readFileSync(
  join(__dirname, '../../../../../../../../tools/desk-reports/tools.mjs'),
  'utf8',
);

const SAME_WORDS = [
  'economy',
  'daily_economy',
  'payments',
  'pack_sales',
  'groups',
  'pack',
];

// Worded for the chat (posters shown in it with a download button, the bank
// and account-link tools, the asker's own role) or for Discord (contact
// details, Telegram), so each side keeps its own text. db_query's is built
// from the money-figures SQL.
const OWN_WORDS = [
  'player',
  'account',
  'order',
  'challenge',
  'challenge_results',
  'signups',
  'packs_opened',
  'top_pulls',
  'tasks',
  'packs',
  'low_stock',
  'admin_read',
  'db_query',
  'challenge_poster',
  'challenge_stages_poster',
  'challenge_results_poster',
  'challenge_standings_poster',
  'brand_poster',
  'achievements_poster',
  'tasks_poster',
  'top_pulls_poster',
  'brand_logo',
];

describe('tool text matches the desk bots', () => {
  it('puts every tool a desk bot also has in one list', () => {
    const shared = TOOLS.map((t) => t.name).filter((name) =>
      desk.includes(`name: '${name}',`),
    );
    expect(shared.sort()).toEqual([...SAME_WORDS, ...OWN_WORDS].sort());
  });

  it.each(SAME_WORDS)('%s', (name) => {
    const tool = TOOLS.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(desk).toContain(tool!.description);
  });

  it('the period argument', () => {
    const economy = TOOLS.find((t) => t.name === 'economy')!;
    const period = (
      economy.parameters as { properties: { period: { description: string } } }
    ).properties.period.description;
    expect(desk).toContain(period);
    expect(period).toContain('are the dashboard 7d and 30d tabs');
  });
});
