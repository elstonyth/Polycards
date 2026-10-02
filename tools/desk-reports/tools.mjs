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
      "The running Weekly Pulled Value Challenge exactly as the public Ranks page shows it: the community pool, each stage with its threshold, whether it is unlocked and how much is still needed, each stage's prizes with the official card image link (card_image: the real art the site shows; use it instead of drawing the card), the prizes the top 10 would get if the week ended now, and the live top-10 standings (shown name, profile handle, pulls, pulled value). Past weeks are not available here. The response gives the challenge week's own start and end; until it ends, the top player is the current leader, not the winner. If hidden_players_above_cut is above 0, prizes are paid by original rank, so do not pair displayed ranks with prizes. Amounts in RM (MYR).",
    inputSchema: {},
    request: () => ({ path: 'challenge', params: {} }),
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
    name: 'challenge_poster',
    description:
      'A finished Weekly Pulled Value Challenge poster (a tall portrait JPEG, 1080 px wide and about 1640 px high, taller with leaders) rendered from live data with the official card art: the unlock headline, the stage chips, and the podium prizes of one stage (default: the highest unlocked stage), optionally with the current top-3 leaders. Use it instead of drawing cards with image generation: post the image it returns. It is a draft; a human reviews it before it is published.',
    inputSchema: {
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
      },
      as: 'image',
    }),
  },
  {
    name: 'brand_poster',
    description:
      "A finished post graphic in the website's own design, for milestones, sign-ups and announcements (the weekly challenge has challenge_poster): the official logo top-left, a big Nekst headline on ink-black, an optional live figure in chase gold, the three most valuable top-hit slabs of the public packs as the hero (their official images), a quiet subline and polycards.gg in the footer. 1080x1350, the 4:5 feed size. Text is English letters and punctuation only (the brand fonts have no Chinese), and numbers cannot be typed in: a figure comes only from metric, live. players = every registered player ever, counted like the admin Stats page; new_players = sign-ups in the last `days` days. round shows the figure exactly or rounded DOWN to the hundred (480 shows as 400+, never 500+). The reply gives the exact live figure: if staff asked for a number the data does not support, tell them the real one. It is a draft; a human reviews it before it is published.",
    inputSchema: {
      headline: z
        .string()
        .describe(
          'The claim, in English, up to 60 characters, no digits. With a figure it reads as the figure\'s label, e.g. "Collectors and counting".',
        ),
      kicker: z
        .string()
        .optional()
        .describe(
          'Optional small label top-right, up to 28 characters, e.g. "Community milestone".',
        ),
      subline: z
        .string()
        .optional()
        .describe(
          'Optional quiet line under the art, up to 120 characters, e.g. "Thank you for every rip."',
        ),
      metric: z
        .enum(['none', 'players', 'new_players'])
        .optional()
        .describe('The live figure to show. Default none.'),
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
          'top_hits (default): three real slabs as the hero; none: type only.',
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
        art: args.art,
      },
      as: 'image',
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

// Hermes saves an image result to its cache and hands the bot a MEDIA: line,
// but attaches the file to the chat only when the reply repeats that line
// (MCP tools are not on its auto-attach list).
const ATTACH =
  "To show it, copy this result's MEDIA: line onto its own line in your reply, unchanged and not in backticks: that line attaches the file.";

// Runs one tool call; failures come back as text the bot can relay.
export async function runTool(tool, args, config) {
  try {
    const { path, params, label, as, brand } = tool.request(args);
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
                ? `Rendered from live data, but the prize card art for rank ${body.missingArt} could not be loaded and shows as a plain placeholder tile. Say so when you post it, and do not call it the official card art; try again later for the full poster.`
                : 'Rendered from live data with the official card art. Post this image as the draft; a human reviews it before it is published.'
            }${
              body.figure
                ? ` The live figure is ${body.figure} (exact, whatever the poster rounds to): say this number if staff asked for a different one.`
                : ''
            } ${ATTACH}`,
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
