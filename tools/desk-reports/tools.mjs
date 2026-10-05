import { readFile } from 'node:fs/promises';
import * as z from 'zod';
import { getReport } from './http.mjs';
import { PERIODS, resolvePeriod } from './periods.mjs';

// Tool arguments shared by the windowed reports.
const windowArgs = {
  period: z
    .enum(PERIODS)
    .describe(
      'Malaysia-time window. today, yesterday, this_week (Mon-Sun), last_week, this_month and last_month are calendar periods; last_7_days and last_30_days are rolling, like the dashboard Weekly and Monthly tabs; custom needs from (and optionally to).',
    ),
  from: z.string().optional().describe('custom only: first day, YYYY-MM-DD.'),
  to: z
    .string()
    .optional()
    .describe('custom only: last day, YYYY-MM-DD, included. Defaults to from.'),
};
const groupArg = {
  group: z
    .string()
    .optional()
    .describe(
      "Player group: 'all' (default), 'default' (the DEFAULT group: players in no other group), or a group name.",
    ),
};

// A report over a period: the backend route, the resolved window, the group.
const windowed = (path) => (args) => {
  const w = resolvePeriod(args.period, args);
  return {
    path,
    params: { from: w.from, to: w.to, group: args.group },
    label: w.label,
  };
};

// Each desk's tools: MCP metadata plus how the arguments become one request.
export const TOOLS = {
  finance: [
    {
      name: 'economy',
      description:
        'Money totals exactly like the admin Economy page, for one Malaysia-time window and player group. revenue = credits spent on packs; payouts = buybacks paid; net = revenue - payouts (the gacha margin); topups = deposits credited; cashout = withdrawals, a signed ledger sum (negative = money paid out to players; report it as an amount paid out); adjustments = admin credit changes (either sign); deliveryFees; referralCommission; rewardPromo = promo credits. Also the current vault and voucher liability for ALL players. Amounts in RM (MYR).',
      inputSchema: { ...windowArgs, ...groupArg },
      request: windowed('economy'),
    },
    {
      name: 'daily_economy',
      description:
        'The same totals as economy, split per Malaysia calendar day (days with no activity are left out). The window must be 93 days or less; all_time is not allowed.',
      inputSchema: { ...windowArgs, ...groupArg },
      request: windowed('daily'),
    },
    {
      name: 'payments',
      description:
        'Payment-gateway deposits and withdrawals created in the window, counted and summed per status, plus what is open right now whatever the window. Deposit statuses: pending, settled, failed, expired. Withdrawal statuses: pending, settled, failed, held (held = waiting for admin approval). Amounts in RM (MYR).',
      inputSchema: { ...windowArgs, ...groupArg },
      request: windowed('payments'),
    },
    {
      name: 'pack_sales',
      description:
        'Per-pack sales in the window: packs opened (paid) and revenue (credits spent, net of reversals), largest first. unattributed_revenue is pack spend from older rows that cannot be linked to a pack; total_revenue equals economy revenue. Amounts in RM (MYR).',
      inputSchema: { ...windowArgs, ...groupArg },
      request: windowed('pack-sales'),
    },
    {
      name: 'player',
      description:
        "One player's account by username (never email): join date, current player group, disabled flag, credit balance, vault cards and value, lifetime and last-30-days ledger totals (revenue = their pack spend, payouts = buybacks to them, cashout = their withdrawals as a signed sum, negative = paid out to them), and their deposits and withdrawals by status. last_30_days_window gives that rolling window's exact start and end as UTC instants; state it in Malaysia time. Amounts in RM (MYR).",
      inputSchema: {
        username: z
          .string()
          .describe(
            "The player's username as shown on their public profile, or their profile handle (the part after /profile/ in their link). If the reply has a lookup_note, tell staff what it says.",
          ),
      },
      request: (args) => ({
        path: 'player',
        params: { username: args.username },
      }),
    },
    {
      name: 'groups',
      description:
        'The player groups and how many players each holds now (by current group). default_players counts players in no group other than DEFAULT. Use these names as the group argument of the other tools.',
      inputSchema: {},
      request: () => ({ path: 'groups', params: {} }),
    },
  ],
};

TOOLS.growth = [
  {
    name: 'challenge',
    description:
      "The Weekly Pulled Value Challenge. week current (default): the running week exactly as the public Ranks page shows it: the community pool, each stage with its threshold, whether it is unlocked and how much is still needed, each stage's prizes with the official card image link (card_image: the real art the site shows; use it instead of drawing the card), the prizes the top 10 would get if the week ended now, and the live top-10 standings (shown name, profile handle, pulls, pulled value). Until the week ends, the top player is the current leader, not the winner. If hidden_players_above_cut is above 0, prizes are paid by original rank, so do not pair displayed ranks with prizes. week next: the next challenge waiting in the admin queue (the one that takes over when it starts): when it starts, its label, each stage's threshold and prizes with official card images; nothing has unlocked yet. Past weeks: use admin_read /admin/challenge/winners. Amounts in RM (MYR).",
    inputSchema: {
      week: z
        .enum(['current', 'next'])
        .optional()
        .describe(
          'current (default): the running week. next: the next queued challenge.',
        ),
    },
    request: (args) => ({ path: 'challenge', params: { week: args.week } }),
  },
  {
    name: 'signups',
    description:
      "New player accounts per Malaysia day (days with none are left out), counted like the admin Stats page, plus first top-ups: players whose first-ever deposit settled in the window, whenever they signed up (not a conversion rate of this window's sign-ups). The window must be 93 days or less; all_time is not allowed.",
    inputSchema: { ...windowArgs },
    request: windowed('signups'),
  },
  {
    name: 'packs_opened',
    description:
      'Packs opened per Malaysia day (days with none are left out; paid packs, plus free welcome packs counted separately; task and challenge prize draws are not counted) and the 10 most-opened packs, for one window and player group. The window must be 93 days or less; all_time is not allowed.',
    inputSchema: { ...windowArgs, ...groupArg },
    request: windowed('packs'),
  },
  {
    name: 'tasks',
    description:
      "The weekly tasks and achievements exactly as the /task page shows them right now: each task's title, what it asks for in plain English (requirement; level = the VIP level a reach_level achievement needs), its prize as the page words it, what the page says the prize is worth (value_myr: a credit's amount, a free rip's pack price, a card's market price today, which moves with the market), the prize's official picture link (image) and when the task stops showing (ends_at). Achievements are listed by VIP level and each is claimed once per account; weekly tasks reset every Monday 00:00 Malaysia time. Use it for anything about tasks, achievements, level or VIP rewards, check-in rewards and free rips: never ask staff for a screenshot of the /task page. Amounts in RM (MYR).",
    inputSchema: {},
    request: () => ({ path: 'tasks', params: {} }),
  },
  {
    name: 'top_pulls',
    description:
      "One Malaysia day's most valuable paid pulls (default yesterday, top 10): rank, when, the card (name, grade, set, tier, slab image), the pack, the pulled value in RM (the card's value when it was pulled, as the Ranks page counts it) and the player's public name and profile handle (the names the site and the Telegram channel already show). Free welcome packs and prize draws are not counted; disabled players are left out. Never contact details. Amounts in RM (MYR).",
    inputSchema: {
      day: z
        .string()
        .optional()
        .describe('The Malaysia day, YYYY-MM-DD. Default: yesterday.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('How many pulls. Default 10.'),
    },
    request: (args) => ({
      path: 'top-pulls',
      params: { day: args.day, limit: args.limit },
    }),
  },
  {
    name: 'challenge_results',
    description:
      "Last week's Weekly Pulled Value Challenge result, exactly as settlement paid it (the most recently settled week): the week's dates, the pool and the stages it unlocked, and for each winner the paid rank, public name and profile handle, that week's pulled value, the cards they received (name, official image, quantity, today's value) and credits, and what the prize is worth today in total. A disabled winner is left out (hidden_winners counts them); the others keep the rank they were paid. Never contact details. Amounts in RM (MYR).",
    inputSchema: {},
    request: () => ({ path: 'challenge-results', params: {} }),
  },
  {
    name: 'challenge_poster',
    description:
      'A finished Weekly Pulled Value Challenge poster (1080x1350, the 4:5 feed size) rendered from live data with the official card art: the unlock headline, the stage chips, and the podium prizes of one stage (default: the highest unlocked stage), optionally with the current top-3 leaders. week next draws the next challenge waiting in the admin queue instead (its own dates; no stage unlocked yet; stage 1 featured by default; no leaders). Use it instead of drawing cards with image generation: post the image it returns. It is a draft; a human reviews it before it is published.',
    inputSchema: {
      week: z
        .enum(['current', 'next'])
        .optional()
        .describe(
          'current (default): the running week. next: the next queued challenge.',
        ),
      stage: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Which stage prizes to feature. Default: the highest unlocked stage.',
        ),
      leaders: z
        .boolean()
        .optional()
        .describe(
          'true adds the current top-3 leaders (shown names). Default false.',
        ),
    },
    request: (args) => ({
      path: 'challenge-poster',
      params: {
        stage: args.stage,
        leaders: args.leaders === undefined ? undefined : args.leaders ? 1 : 0,
        ...(args.week ? { week: args.week } : {}),
      },
      as: 'image',
    }),
  },
  {
    name: 'challenge_results_poster',
    description:
      "The results of the most recently settled Weekly Challenge week as two finished posting images, each 1080x1350 (the 4:5 size Facebook and Instagram feeds show whole). part top (default): the top 3, with every prize card they won side by side and named (the most valuable first), their public name, what they pulled and what they won. part rest: ranks 4 to 10 with what they pulled and won. Post both together (a carousel: top first). Every figure comes from settlement's own records; nothing is typed in. Use it for any post about last week's winners or results. It is a draft; a human reviews it before it is published.",
    inputSchema: {
      part: z
        .enum(['top', 'rest'])
        .optional()
        .describe(
          'top (default): the top 3 and their cards. rest: ranks 4-10.',
        ),
    },
    request: (args) => ({
      path: 'challenge-results-poster',
      params: args.part ? { part: args.part } : {},
      as: 'image',
      artOf: 'podium rank',
    }),
  },
  {
    name: 'challenge_stages_poster',
    description:
      "A finished poster of every stage of the Weekly Pulled Value Challenge on one image (1080x1350, the 4:5 feed size): each stage's unlock threshold, its #1 to #3 prizes as the official card art, and what ranks 4 to 10 win, under the line that every reward stacks. week current (default): the running week, with its unlocked stages marked; week next: the next challenge waiting in the admin queue. Use it for posts about the new week's prizes or all the stages at once (challenge_poster features one stage with a big podium). It is a draft; a human reviews it before it is published.",
    inputSchema: {
      week: z
        .enum(['current', 'next'])
        .optional()
        .describe(
          'current (default): the running week. next: the next queued challenge.',
        ),
    },
    request: (args) => ({
      path: 'challenge-stages-poster',
      params: args.week ? { week: args.week } : {},
      as: 'image',
      artOf: 'stage:rank',
    }),
  },
  {
    name: 'brand_poster',
    description:
      "A finished post graphic drawn as the website's own home hero, for milestones, sign-ups and announcements (the weekly challenge has challenge_poster): the official logo, a small eyebrow, an optional live figure in chase gold, a big sentence-case Nekst headline, a quiet line, the white Open a pack pill with polycards.gg, the site's top 3 chase cards fanned in their tier frames, and the site's Top 3 chase cards panel with the lead card's live price. 1080x1350, the 4:5 feed size. Write like the site's hero: short sentence-case lines ending in a full stop, e.g. headline 'Collectors and counting.' Text is English letters and punctuation only (the brand fonts have no Chinese), and numbers cannot be typed in: a figure comes only from metric, live. players = every registered player ever, counted like the admin Stats page; new_players = sign-ups in the last `days` days; packs_opened = paid packs opened since launch (a big true number). round shows the figure exactly or rounded DOWN to the hundred (480 shows as 400+, never 500+). When staff ask for a number the live figure has not reached (like 1,000 when 485 have signed up), do not refuse: pass it as goal, and the poster shows it big as 'Road to 1,000' with the live progress. The reply gives the exact live figure. It is a draft; a human reviews it before it is published.",
    inputSchema: {
      headline: z
        .string()
        .describe(
          'The claim in English, sentence case like the site ("Open packs. Pull real cards."), up to 60 characters, no digits. With a figure it reads as its label, e.g. "Collectors and counting."',
        ),
      kicker: z
        .string()
        .optional()
        .describe(
          'Optional eyebrow above the headline, up to 28 characters, e.g. "Community milestone".',
        ),
      subline: z
        .string()
        .optional()
        .describe(
          'Optional quiet line under the headline, up to 120 characters, e.g. "Thank you for every rip."',
        ),
      metric: z
        .enum(['none', 'players', 'new_players', 'packs_opened'])
        .optional()
        .describe(
          'The live figure to show. players = every registered player ever; new_players = sign-ups in the last `days`; packs_opened = paid packs opened since launch. Default none.',
        ),
      goal: z
        .number()
        .int()
        .min(10)
        .max(10_000_000)
        .optional()
        .describe(
          'A target for the metric, e.g. 1000. Until the live figure reaches it, the poster shows it as the goal ("Road to 1,000", the big number in gold, with the live progress like "485 of 1,000"); once reached, it shows "1,000+". Use it whenever staff ask for a number the live figure has not reached.',
        ),
      days: z
        .number()
        .int()
        .min(1)
        .max(93)
        .optional()
        .describe('new_players only: how many days back. Default 3.'),
      round: z
        .enum(['exact', 'hundred'])
        .optional()
        .describe('exact (default) or hundred: rounded down, like 400+.'),
      art: z
        .enum(['top_hits', 'none'])
        .optional()
        .describe(
          "top_hits (default): the site's top 3 chase cards as the hero; none: type only.",
        ),
    },
    request: (args) => ({
      path: 'brand-poster',
      params: {
        headline: args.headline,
        kicker: args.kicker,
        subline: args.subline,
        metric: args.metric,
        days: args.days,
        round: args.round,
        goal: args.goal,
        art: args.art,
      },
      as: 'image',
      artOf: 'hero card',
    }),
  },
  {
    name: 'achievements_poster',
    description:
      "A finished poster of the VIP-level achievements ladder, drawn from live data in the website's design (1080x1350, the 4:5 feed size): the official logo, the Achievements eyebrow, the headline 'Level up. Unlock real rewards.', one tile per level with the prize's official picture, its name as the /task page words it and what /task says it is worth in chase gold, and the Open a pack pill with polycards.gg/task. Nothing on it is typed in (the words are fixed; every prize and value is live), so it takes no text. Default: every live VIP-level achievement (a poster fits 10); min_level and max_level narrow it, e.g. 60 to 100 for the card prizes. Use it whenever staff want a post about achievements, level rewards or what players win by levelling up. It is a draft; a human reviews it before it is published.",
    inputSchema: {
      min_level: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('The lowest VIP level to show. Default: all.'),
      max_level: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('The highest VIP level to show. Default: all.'),
    },
    request: (args) => ({
      path: 'achievements-poster',
      params: { min_level: args.min_level, max_level: args.max_level },
      as: 'image',
      artOf: 'level',
    }),
  },
  {
    name: 'tasks_poster',
    description:
      "A finished poster of this week's tasks exactly as the /task page shows them right now (1080x1350, the 4:5 feed size): the daily check-in tiers as one strip (each day count with its prize and value), then one tile per other weekly task (like 'Rip 10 × Bronze Pack') with its prize and what /task says it is worth. Nothing on it is typed in. Use it for any post about the week's tasks, check-in rewards or free rips. It is a draft; a human reviews it before it is published.",
    inputSchema: {},
    request: () => ({
      path: 'tasks-poster',
      params: {},
      as: 'image',
      artOf: 'prize',
    }),
  },
  {
    name: 'top_pulls_poster',
    description:
      "A finished posting poster of one Malaysia day's top paid pulls (default yesterday, top 10), drawn from live data in the website's design (1080x1350, the 4:5 feed size): the official logo, a trophy eyebrow with the date, the headline 'Real cards. Real pulls.', one tile per pull with the card's official slab, its rank, the player's public name, the card and its pulled value in chase gold, and the Open a pack pill. Nothing on it is typed in, so it takes no text. Use it for any post about top hits, big pulls or the day's best cards. It is a draft; a human reviews it before it is published.",
    inputSchema: {
      day: z
        .string()
        .optional()
        .describe('The Malaysia day, YYYY-MM-DD. Default: yesterday.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('How many pulls on the poster. Default 10.'),
    },
    request: (args) => ({
      path: 'top-pulls-poster',
      params: { day: args.day, limit: args.limit },
      as: 'image',
      artOf: 'rank',
    }),
  },
  {
    name: 'brand_logo',
    description:
      'An official Polycards logo file, for designs and posts. wordmark (default): the white "Polycards" wordmark on a transparent background (PNG, 360x97), for dark designs. mark: the app icon, the white card mark on a near-black square (PNG, 512x512). Use the file exactly as it is: attach it, or place it unchanged. Never draw, redraw, recolour or imitate the logo with image generation. The challenge and brand posters already carry the logo, and every generated image gets it added automatically.',
    inputSchema: {
      variant: z
        .enum(['wordmark', 'mark'])
        .optional()
        .describe('wordmark (default) or mark.'),
    },
    request: (args) => ({ brand: BRAND[args.variant ?? 'wordmark'] }),
  },
];

// The official logo files, shipped with this server (copies of the
// storefront's public/branding/polycards-logo.png and src/app/icon.png).
const BRAND = {
  wordmark: {
    file: 'polycards-wordmark-white.png',
    note: 'The official Polycards wordmark: white on transparent, 360x97 px, for dark backgrounds. Use it unchanged.',
  },
  mark: {
    file: 'polycards-mark.png',
    note: 'The official Polycards app icon: the white card mark on a #171717 square, 512x512 px. Use it unchanged.',
  },
};

TOOLS.store = [
  {
    name: 'packs',
    description:
      "Every pack with the numbers the admin pack list shows: title, category, status, whether it is listed publicly, the sold-out badge (display only: a pack showing it can still be opened), price, buyback %, pool mix (RAW, GRADED or MIX), the published tier odds with their EV and RTP, and the real EV and RTP of odds set 1 (what the DEFAULT group plays) at today's card prices. Amounts in RM (MYR).",
    inputSchema: {},
    request: () => ({ path: 'packs', params: {} }),
  },
  {
    name: 'pack',
    description:
      'One pack by slug (drafts included): the same numbers as packs, plus its pool by rarity (cards, average display price, cards with no stock left, cards with untracked stock) and its top hits with their display price and stock on hand. Never per-card win chances.',
    inputSchema: {
      slug: z.string().describe('The pack slug, like silver-pack.'),
    },
    request: (args) => ({ path: 'pack', params: { slug: args.slug } }),
  },
  {
    name: 'low_stock',
    description:
      'Cards whose tracked stock on hand is at or below max (default 0; below 0 = units owed to winners): matching_cards and owed (cards and units) count all of them, and cards lists the lowest ones first (limit, default 50), with the active packs that can still draw them, plus the packs showing the sold-out badge. Give the counts, not the length of the list. A card at 0 can still be drawn (buyback covers it). Cards with untracked stock are not listed. Amounts in RM (MYR).',
    inputSchema: {
      max: z
        .number()
        .int()
        .optional()
        .describe(
          'List cards with on_hand at or below this. Default 0; -1 = only cards owed to winners.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('How many cards to list, lowest first. Default 50.'),
    },
    request: (args) => ({
      path: 'stock',
      params: { max: args.max, limit: args.limit },
    }),
  },
];

TOOLS.support = [
  {
    name: 'order',
    description:
      "One delivery order by the number the customer sees (like #A1B2C3) or its full id: status and the customer's wording for it, the player's shown name, the cards in it, tracking number, fees, when it was requested, shipped and completed, and staff status changes. If several orders share the number, all are listed. The delivery address and phone are never included: ask the customer to check them in their account. A tracking number in an unusual format is withheld (has_tracking_number says one exists). Discuss an order only with the player named in player.",
    inputSchema: {
      number: z
        .string()
        .describe(
          'The order number, like #A1B2C3 or A1B2C3, or the full order id.',
        ),
    },
    request: (args) => ({ path: 'order', params: { number: args.number } }),
  },
  {
    name: 'account',
    description:
      "One player's account status by shown name or profile handle (never email or phone): join date, disabled, frozen, phone verified yes/no, VIP level, paid pack pulls (lifetime and last 30 days; free and prize draws not counted), the last 5 delivery orders, and deposits and withdrawals created in the last 30 days by status. If the reply has a lookup_note, tell staff what it says. Amounts in RM (MYR).",
    inputSchema: {
      username: z
        .string()
        .describe(
          "The player's shown name, or their profile handle (the part after /profile/ in their link).",
        ),
    },
    request: (args) => ({
      path: 'account',
      params: { username: args.username },
    }),
  },
];

// Any admin dashboard screen, read-only (2026-10-04, the owner's "full
// access"): backend reports/admin/proxy.ts holds the rules and the blocks.
TOOLS.admin = [
  {
    name: 'admin_read',
    description:
      'Read any admin dashboard screen, read-only: the same data the admin dashboard shows, for anything the other tools do not cover. Use it before ever asking staff for a screenshot. path is the admin API path; put filters in params (limit and offset on lists, q to search, fields to pick columns on core screens; a single-record screen takes none of them). Useful paths: customers /admin/customers (q=search), /admin/customers/{id}, /admin/customers/{id}/transactions, /admin/customers/{id}/pulls, /admin/customers/{id}/spend-report, /admin/customers/{id}/audit, /admin/customers/{id}/referral, /admin/customer-groups, /admin/players (q=username); delivery /admin/delivery-orders, /admin/delivery-orders/{id}; packs and cards /admin/packs, /admin/packs/{slug}, /admin/packs/{slug}/odds, /admin/cards/{handle}, /admin/inventory (q=card name; unfiltered it lists every card, too long to read whole, like /admin/cards), /admin/inventory/{handle}, /admin/pulls; money /admin/economy, /admin/ledger, /admin/stats, /admin/payments/deposits, /admin/payments/withdrawals (bank numbers masked), /admin/payments/settlement, /admin/payments/balance (the payout float), /admin/purchase-invoices; challenge /admin/challenge/stages (live), /admin/challenge/schedule (the queue of coming weeks), /admin/challenge/settings, /admin/challenge/winners (past weeks); tasks and VIP /admin/tasks, /admin/vip-levels, /admin/tier-settings; referral /admin/referrals/settings, /admin/referrals/settlements; settings /admin/site-settings, /admin/rewards-settings, /admin/pricing/fx. Not open: staff logins, API keys, full bank numbers, PriceCharting lookups, file exports. Passwords and secrets come back as [hidden], and bank account numbers as their last 4 digits. An answer over 40,000 characters comes back cut (truncated: true): ask again narrower. Customer contact details stay in this staff channel: never post them publicly or put them into web searches or URLs.',
    inputSchema: {
      path: z
        .string()
        .describe(
          'The admin API path, starting /admin/, like /admin/customers.',
        ),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
          'Filters for that screen, like {"q": "Ace", "limit": 20, "offset": 0}.',
        ),
    },
    request: (args) => ({
      path: 'read',
      params: { ...(args.params ?? {}), path: args.path },
    }),
  },
];

// Every desk reads every desk's reports (2026-10-03): one flat list, each
// tool tagged with the desk whose route it calls. Names are unique.
export const ALL_TOOLS = Object.entries(TOOLS).flatMap(([desk, tools]) =>
  tools.map((tool) => ({ ...tool, desk })),
);

// Hermes saves an image result to its cache and hands the bot a MEDIA: line,
// but attaches the file to the chat only when the reply repeats that line
// (MCP tools are not on its auto-attach list).
const ATTACH =
  "To show it, copy this result's MEDIA: line onto its own line in your reply, unchanged and not in backticks: that line attaches the file.";

// What a goal poster shows, for the bot to tell staff in one line.
const goalNote = (body, goal) => {
  if (!goal || !body.goalReached) return '';
  const g = Number(goal).toLocaleString('en-MY');
  return body.goalReached === '1'
    ? ` The goal is reached: the poster shows ${g}+.`
    : ` It is a goal poster: "Road to ${g}", with ${g} in gold and the live progress (${Number(body.figure).toLocaleString('en-MY')} of ${g}). Post it, and tell staff in one friendly line that ${g} is shown as the goal because the live figure is ${Number(body.figure).toLocaleString('en-MY')}.`;
};

// '10,20,30' as the bot should say it: 'Lv.10, Lv.20 and Lv.30'.
const levelList = (levels) => {
  const named = levels.split(',').map((l) => `Lv.${l}`);
  return named.length > 1
    ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
    : named[0];
};

// What an achievements poster drew, and what it left off.
const levelsNote = (body) =>
  `${
    body.levels
      ? ` It shows ${levelList(body.levels)}, with today's values (card values move with the market).`
      : ''
  }${
    body.skipped
      ? ` ${levelList(body.skipped)} ${body.skipped.includes(',') ? 'are' : 'is'} left off: that prize no longer exists, so nobody can claim it. Tell staff to fix that achievement in the admin Tasks console.`
      : ''
  }`;

// Runs one tool call; failures come back as text the bot can relay.
export async function runTool(tool, args, config) {
  try {
    const {
      path,
      params,
      label,
      as,
      brand,
      artOf = 'podium rank',
    } = tool.request(args);
    if (brand) {
      const data = await readFile(
        new URL(`./brand/${brand.file}`, import.meta.url),
      );
      return {
        content: [
          {
            type: 'image',
            data: data.toString('base64'),
            mimeType: 'image/png',
          },
          { type: 'text', text: `${brand.note} ${ATTACH}` },
        ],
      };
    }
    // A poster fetches its prize art server-side, so it gets longer.
    const body = await getReport({
      ...config,
      // The tool's own desk: any desk's server serves every desk's tools.
      desk: tool.desk ?? config.desk,
      path,
      params,
      as,
      ...(as === 'image' ? { timeoutMs: 45_000 } : {}),
    });
    if (as === 'image') {
      return {
        content: [
          { type: 'image', data: body.data, mimeType: body.mimeType },
          {
            type: 'text',
            text: `${
              body.missingArt
                ? `Rendered from live data, but the art for ${artOf} ${body.missingArt} could not be loaded and shows as a plain placeholder tile. Say so when you post it, and do not call it the official art; try again later for the full poster.`
                : 'Rendered from live data with the official art. Post this image as the draft; a human reviews it before it is published.'
            }${levelsNote(body)}${body.note ? ` ${body.note}` : ''}${
              body.figure
                ? ` The live figure is ${body.figure} (exact, whatever the poster rounds to): say this number if staff asked for a different one.`
                : ''
            }${goalNote(body, args.goal)} ${ATTACH}`,
          },
        ],
      };
    }
    // Compact: Hermes spills an MCP result over 50K chars to a file the bot
    // cannot read, and indentation alone can add a third.
    const text = JSON.stringify(label ? { period: label, ...body } : body);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}
