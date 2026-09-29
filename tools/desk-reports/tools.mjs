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
        'Money totals exactly like the admin Economy page, for one Malaysia-time window and player group. revenue = credits spent on packs; payouts = buybacks paid; net = revenue - payouts (the gacha margin); topups = deposits credited; cashout = withdrawals; adjustments = admin credit changes; deliveryFees; referralCommission; rewardPromo = promo credits. Also the current vault and voucher liability for ALL players. Amounts in RM (MYR).',
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
        "One player's account by username (never email): join date, current player group, disabled flag, credit balance, vault cards and value, lifetime and last-30-days ledger totals (revenue = their pack spend, payouts = buybacks to them), and their deposits and withdrawals by status. Amounts in RM (MYR).",
      inputSchema: {
        username: z
          .string()
          .describe("The player's username, as shown on their public profile."),
      },
      request: (args) => ({
        path: 'player',
        params: { username: args.username },
      }),
    },
  ],
};

// Runs one tool call; failures come back as text the bot can relay.
export async function runTool(tool, args, config) {
  try {
    const { path, params, label } = tool.request(args);
    const body = await getReport({ ...config, path, params });
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
