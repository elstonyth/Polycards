// Sets up the Growth desk's 12 a.m. "Daily Top Hits" Hermes cron job (spec
// docs/superpowers/specs/2026-10-04-growth-daily-hits-design.md). Run with
// the gateway STOPPED, after install.mjs has put daily_hits.py in the growth
// profile's scripts folder:
//
//   node tools/desk-reports/cron/setup-growth-cron.mjs
//
// It locks the profile's cron toolset to the report tools (a cron job would
// otherwise get Hermes' full cron bundle, terminal and file tools included),
// turns off the "Cronjob Response" wrapper, and creates the job unless one
// with the same name exists. Hermes is started through its own interpreter
// (bin\hermes.cmd's program), as the ops scripts do: a shell would mangle the
// JSON value and the prompt.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERMES_HOME = join(process.env.LOCALAPPDATA, 'hermes');
const LAUNCHER = readFileSync(join(HERMES_HOME, 'bin', 'hermes.cmd'), 'utf8');
const PYTHON = LAUNCHER.match(/^"([^"]+python\.exe)"/m)[1];
const PRE = ['-I', '-c', LAUNCHER.match(/ -c "([^"]+)"/)[1]];
const PROFILE = 'polycards-growth';
const NAME = 'growth-daily-hits';
// The Growth desk channel (#📈・growth-desk).
const DELIVER = 'discord:1554355077995823195';

const hermes = (...args) =>
  execFileSync(PYTHON, [...PRE, '-p', PROFILE, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const PROMPT = `You are posting tonight's Daily Top Hits drop in the Growth desk. The script output above is your only data: yesterday's top paid pulls (Malaysia time), the withdrawal summary and the files. Write ONE post for staff, in this order:
1. A bold first line: Daily Top Hits, then the date in words (for example 3 Oct 2026).
2. The top pulls as a numbered list exactly as given: rank, card, value in RM and the player's public name. Do not re-rank, round or add any number.
3. One line: the withdrawals requested that day, exactly as given.
4. A ready-to-post English caption for Instagram and Facebook announcing yesterday's top pulls: hype, premium and trustworthy, two to four short lines plus three to five hashtags, mentioning polycards.gg. Name at most the top 3 cards with their values. No promises of winning, no casino or gambling words, nothing about odds.
5. One line: the Excel holds full customer details (phone, email, bank) for staff only; never post it or its contents publicly.
Then copy every MEDIA: line from the script output, each on its own line, unchanged and not in backticks: they attach the poster, the Telegram cards and the Excel.
If the script output says DAILY TOP HITS FAILED or lists a PROBLEM, say so plainly in one line and still post what you have. If there were no paid pulls, say so and skip the caption.`;

hermes('config', 'set', 'platform_toolsets.cron', '["polycards_growth"]');
hermes('config', 'set', 'cron.wrap_response', 'false');
console.log(
  'growth cron toolset locked to polycards_growth; response wrapper off',
);

const list = hermes('cron', 'list');
if (list.includes(NAME)) {
  console.log(`a job named ${NAME} already exists: left as is`);
} else {
  const out = hermes(
    'cron',
    'create',
    '0 0 * * *',
    PROMPT,
    '--name',
    NAME,
    '--script',
    'daily_hits.py',
    '--deliver',
    DELIVER,
  );
  console.log(out.trim());
}
console.log(hermes('cron', 'list').trim());
