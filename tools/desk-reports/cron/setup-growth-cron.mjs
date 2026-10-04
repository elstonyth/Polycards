// Sets up the Growth desk's nightly Hermes cron jobs (spec
// docs/superpowers/specs/2026-10-04-growth-daily-hits-design.md), after
// install.mjs has put daily_hits.py, daily_excel.py and weekly_posts.py in
// the growth profile's scripts folder:
//
//   node tools/desk-reports/cron/setup-growth-cron.mjs
//
//   growth-daily-hits  0 0 * * *  the AI-written Daily Top Hits post, with the
//                                 poster and the 10 Telegram pull cards
//   growth-daily-excel 5 0 * * *  the staff Excel, posted verbatim (no AI), so
//                                 no model decides whether bank details go out
//   growth-weekly-posts 0 9 * * 1  Mondays: the AI-written weekly posts, with
//                                 the results, stages and tasks posters
//
// It locks the profile's cron toolset to the report tools (a cron job would
// otherwise get Hermes' full cron bundle, terminal and file tools included)
// and turns off the "Cronjob Response" wrapper. Idempotent: an existing
// growth-daily-hits job gets the current prompt; a missing job is created.
// Hermes is started through its own interpreter (bin\hermes.cmd's program),
// as the ops scripts do: a shell would mangle the JSON value and the prompt.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERMES_HOME = join(process.env.LOCALAPPDATA, 'hermes');
const LAUNCHER = readFileSync(join(HERMES_HOME, 'bin', 'hermes.cmd'), 'utf8');
const PYTHON = LAUNCHER.match(/^"([^"]+python\.exe)"/m)[1];
const PRE = ['-I', '-c', LAUNCHER.match(/ -c "([^"]+)"/)[1]];
const PROFILE = 'polycards-growth';
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
5. One line: the staff Excel with full customer details follows at 00:05 in its own message, for staff only.
Then copy every MEDIA: line from the script output, each on its own line, unchanged and not in backticks: they attach the poster and the Telegram pull cards.
If the script output says DAILY TOP HITS FAILED or lists a PROBLEM, say so plainly in one line and still post what you have. If there were no paid pulls, say so and skip the caption.`;

// Spec docs/superpowers/specs/2026-10-04-growth-weekly-posts-design.md.
const WEEKLY_PROMPT = `You are posting this Monday's weekly posts in the Growth desk. The script output above is your only data: last week's Weekly Challenge result, this week's challenge stages, this week's tasks and the three poster files. Write ONE post for staff, in this order:
1. A bold first line: Weekly Posts, then this week's dates exactly as the data words them.
2. For each poster, in the order results, challenge stages, tasks: a short bold heading, then a ready-to-post English caption for Instagram and Facebook: hype, premium and trustworthy, two to four short lines plus three to five hashtags, mentioning polycards.gg. Use only the names, cards and figures in the data; do not re-rank, round differently or add any number. The results caption congratulates the top winners by their public names. The stages caption says every reward stacks: each stage the community pool unlocks adds its prizes for the top 10 on top of the earlier stages. The tasks caption names the tasks and their prizes. No promises of winning, no casino or gambling words, nothing about odds.
Then copy every MEDIA: line from the script output, each on its own line, unchanged and not in backticks: they attach the posters.
If the script output says WEEKLY POSTS FAILED or lists a PROBLEM, say so plainly in one line and still post what you have; skip the caption of a poster that is missing.`;

/** The id of the job called `name` in `hermes cron list`, or null. */
function jobId(name) {
  const lines = hermes('cron', 'list').split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (new RegExp(`^\\s*Name:\\s+${name}\\s*$`).test(line)) {
      return /^\s*([0-9a-f]{12})\s/.exec(lines[i - 1] ?? '')?.[1] ?? null;
    }
  }
  return null;
}

hermes('config', 'set', 'platform_toolsets.cron', '["polycards_growth"]');
hermes('config', 'set', 'cron.wrap_response', 'false');
console.log(
  'growth cron toolset locked to polycards_growth; response wrapper off',
);

const hits = jobId('growth-daily-hits');
if (hits) {
  hermes('cron', 'edit', hits, '--prompt', PROMPT);
  console.log(`growth-daily-hits (${hits}): prompt updated`);
} else {
  hermes(
    'cron',
    'create',
    '0 0 * * *',
    PROMPT,
    '--name',
    'growth-daily-hits',
    '--script',
    'daily_hits.py',
    '--deliver',
    DELIVER,
  );
  console.log('growth-daily-hits: created');
}

if (jobId('growth-daily-excel')) {
  console.log('growth-daily-excel: already exists');
} else {
  hermes(
    'cron',
    'create',
    '5 0 * * *',
    '--name',
    'growth-daily-excel',
    '--script',
    'daily_excel.py',
    '--no-agent',
    '--deliver',
    DELIVER,
  );
  console.log('growth-daily-excel: created');
}

const weekly = jobId('growth-weekly-posts');
if (weekly) {
  hermes('cron', 'edit', weekly, '--prompt', WEEKLY_PROMPT);
  console.log(`growth-weekly-posts (${weekly}): prompt updated`);
} else {
  hermes(
    'cron',
    'create',
    '0 9 * * 1',
    WEEKLY_PROMPT,
    '--name',
    'growth-weekly-posts',
    '--script',
    'weekly_posts.py',
    '--deliver',
    DELIVER,
  );
  console.log('growth-weekly-posts: created');
}
console.log(hermes('cron', 'list').trim());
