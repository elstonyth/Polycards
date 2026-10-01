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
    name: 'brand_logo',
    description:
      'An official Polycards logo file, for designs and posts. wordmark (default): the white "Polycards" wordmark on a transparent background (PNG, 360x97), for dark designs. mark: the app icon, the white card mark on a near-black square (PNG, 512x512). Use the file exactly as it is: attach it, or place it unchanged. Never draw, redraw, recolour or imitate the logo with image generation. The challenge poster already carries the logo.',
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
          { type: 'text', text: brand.note },
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
            text: body.missingArt
              ? `Rendered from live data, but the prize card art for rank ${body.missingArt} could not be loaded and shows as a plain placeholder tile. Say so when you post it, and do not call it the official card art; try again later for the full poster.`
              : 'Rendered from live data with the official card art. Post this image as the draft; a human reviews it before it is published.',
          },
        ],
      };
    }
    const text = JSON.stringify(
      label ? { period: label, ...body } : body,
      null,
      2,
    );
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
