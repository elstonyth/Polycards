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
        'Payment-gateway deposits and withdrawals created in the window, counted and summed per status (pending, settled, failed, expired; withdrawals also held = waiting for admin approval), plus what is open right now whatever the window. Amounts in RM (MYR).',
      inputSchema: { ...windowArgs, ...groupArg },
      request: windowed('payments'),
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
