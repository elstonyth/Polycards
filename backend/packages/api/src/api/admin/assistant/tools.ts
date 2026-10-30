import type { MedusaContainer } from '@medusajs/framework/types';
import { BRAND_LOGO_B64 } from '../../../modules/packs/pull-card-assets';
import { capBody } from '../../reports/admin/proxy';
import type { Access, Need } from './access';
import type { Proposal } from './confirm';
import { adminReadAs, callReport, type ReportImage } from './bridge';
import { brandImage, generateImage } from './images';
import { artPrompt } from './brand-style';
import { AGENT_TOOLS, assetBytes, assetDataUrls } from './agent-tools';
import {
  composePoster,
  posterCopyError,
  type PosterCopy,
} from './poster-compose';
import { PERIODS, resolvePeriod } from './periods';

// What the assistant can look up or make (spec 2026-10-29). The data tools
// are the Discord desk tools (tools/desk-reports/tools.mjs) with the same
// descriptions, minus the Discord-only parts. Each tool names the RBAC
// policy of the admin screen that shows the same data (`needs`); the model
// is only ever offered the tools the asker's roles allow (access.ts), and
// the chat route checks again before running one.

export type ToolCtx = {
  container: MedusaContainer;
  port: number;
  access: Access;
  openrouterKey: string;
  imageModel: string;
  /** The house look for AI images (Settings → AI, or brand-style.ts). */
  imageStyle: string;
  /** The brand's own past posts the image model matches, as data URLs. */
  styleRefs: string[];
  /** This turn's screenshots, as data URLs. */
  attachments: string[];
  /** Stores an image, shows it in the chat, gives its URL. */
  showImage(image: Buffer, name: string, mime?: string): Promise<string>;
  /** True once any tool output is in this turn: what was read (a customer
   *  field, a past chat) may carry instructions, so a few writes refuse. */
  readOutside?: boolean;
  /** The asker's message this turn. */
  userText?: string;
  /** Adds an image model's cost to the turn. */
  addCost(usd: number): void;
  /** Shows the person a note or task to save with a tap (confirm.ts). */
  propose?(proposal: Proposal, summary: string): void;
  signal: AbortSignal;
};

export type AssistantTool = {
  name: string;
  /** A short label for the chat's step timeline. */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  needs: Need[];
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
};

const read = (resource: string): Need => ({ resource, operation: 'read' });
const IMAGES: Need = { resource: 'assistant_image', operation: 'create' };

// --- JSON Schema helpers --------------------------------------------------

const str = (description: string) => ({ type: 'string', description });
const int = (description: string, min?: number, max?: number) => ({
  type: 'integer',
  description,
  ...(min === undefined ? {} : { minimum: min }),
  ...(max === undefined ? {} : { maximum: max }),
});
const oneOf = (values: readonly string[], description: string) => ({
  type: 'string',
  enum: values,
  description,
});
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: 'object', properties, required, additionalProperties: false });

const windowProps = {
  period: oneOf(
    PERIODS,
    'Malaysia-time window. today, yesterday, this_week (Mon-Sun), last_week, this_month and last_month are calendar periods; last_7_days and last_30_days are rolling, like the dashboard Weekly and Monthly tabs; custom needs from (and optionally to).',
  ),
  from: str('custom only: first day, YYYY-MM-DD.'),
  to: str('custom only: last day, YYYY-MM-DD, included. Defaults to from.'),
};
const groupProp = {
  group: str(
    "Player group: 'all' (default), 'default' (the DEFAULT group: players in no other group), or a group name. When staff say 'only default group' / '只算 default group', pass 'default'.",
  ),
};
const weekProp = (what: string) => ({
  week: oneOf(
    ['current', 'next'],
    `current (default): ${what}. next: the next one queued.`,
  ),
});

// --- result helpers --------------------------------------------------------

const text = (body: unknown, label?: string) =>
  JSON.stringify(
    capBody(
      label && body && typeof body === 'object'
        ? { period: label, ...(body as object) }
        : body,
    ),
  );

const s = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
// The model sometimes sends numbers and booleans as strings ("20",
// "false"): read them as what they say, never drop or flip them.
const n = (v: unknown) => {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
};
const b = (v: unknown) =>
  v === true || v === 'true'
    ? true
    : v === false || v === 'false'
      ? false
      : undefined;

/** A windowed report: the period resolves here, like the desks' tools. */
const windowed =
  (desk: 'finance' | 'growth', path: string, withGroup = true) =>
  async (args: Record<string, unknown>, ctx: ToolCtx) => {
    const w = resolvePeriod(String(args.period ?? 'today'), args);
    const body = await callReport({
      port: ctx.port,
      desk,
      path,
      signal: ctx.signal,
      userId: ctx.access.userId,
      params: {
        from: w.from,
        to: w.to,
        ...(withGroup ? { group: s(args.group) } : {}),
      },
    });
    return text(body, w.label);
  };

const report =
  (
    desk: 'finance' | 'growth' | 'store' | 'support',
    path: string,
    params: (
      a: Record<string, unknown>,
    ) => Record<string, unknown> = () => ({}),
  ) =>
  async (args: Record<string, unknown>, ctx: ToolCtx) =>
    text(
      await callReport({
        port: ctx.port,
        desk,
        path,
        signal: ctx.signal,
        userId: ctx.access.userId,
        params: params(args) as Record<string, string | number | undefined>,
      }),
    );

const levelList = (levels: string) => {
  const named = levels.split(',').map((l) => `Lv.${l}`);
  return named.length > 1
    ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
    : named[0];
};

/** A rendered poster: shown in the chat, described to the model. */
const poster =
  (
    path: string,
    params: (a: Record<string, unknown>) => Record<string, unknown>,
    artOf = 'podium rank',
  ) =>
  async (args: Record<string, unknown>, ctx: ToolCtx) => {
    const img = (await callReport({
      port: ctx.port,
      desk: 'growth',
      path,
      signal: ctx.signal,
      userId: ctx.access.userId,
      params: params(args) as Record<string, string | number | undefined>,
      image: true,
    })) as ReportImage;
    await ctx.showImage(img.buffer, `${path}.jpg`, img.mime);
    const h = img.headers;
    const notes = [
      h['x-poster-missing-art']
        ? `Rendered from live data, but the art for ${artOf} ${h['x-poster-missing-art']} could not be loaded and shows as a plain placeholder tile: say so, and do not call it the official art.`
        : 'Rendered from live data with the official art. It is shown to staff in the chat with a download button; it is a draft a human reviews before posting.',
      h['x-poster-levels']
        ? `It shows ${levelList(h['x-poster-levels'])}, with today's values.`
        : '',
      h['x-poster-skipped']
        ? `${levelList(h['x-poster-skipped'])} left off: that prize no longer exists. Tell staff to fix it in the admin Tasks console.`
        : '',
      h['x-poster-note'] ?? '',
      h['x-poster-figure']
        ? `The live figure is ${h['x-poster-figure']} (exact, whatever the poster rounds to).`
        : '',
      args.goal && h['x-poster-goal-reached'] === '0'
        ? `It is a goal poster: "Road to ${Number(args.goal).toLocaleString('en-MY')}" with the live progress. Tell staff in one line that the goal is shown because the live figure is lower.`
        : '',
    ];
    return notes.filter(Boolean).join(' ');
  };

// --- the catalog -----------------------------------------------------------

export const TOOLS: AssistantTool[] = [
  // Finance (the admin Economy page's policy).
  {
    name: 'economy',
    label: 'Economy totals',
    description:
      'Money totals exactly like the admin Economy page, for one Malaysia-time window and player group. revenue = credits spent on packs; payouts = buybacks paid; net = revenue - payouts (the gacha margin); topups = deposits credited; cashout = withdrawals taken from wallets, a signed ledger sum (negative = money withdrawn; report it as an amount withdrawn, never as paid out: it includes withdrawals still pending at the gateway, and the payments tool tells settled from pending); adjustments = admin credit changes (either sign); deliveryFees; referralCommission; rewardPromo = promo credits. Also the current vault and voucher liability for ALL players. Amounts in RM (MYR).',
    parameters: object({ ...windowProps, ...groupProp }, ['period']),
    needs: [read('economy')],
    run: windowed('finance', 'economy'),
  },
  {
    name: 'daily_economy',
    label: 'Economy per day',
    description:
      'The same totals as economy, split per Malaysia calendar day (days with no activity are left out). The window must be 93 days or less; all_time is not allowed.',
    parameters: object({ ...windowProps, ...groupProp }, ['period']),
    needs: [read('economy')],
    run: windowed('finance', 'daily'),
  },
  {
    name: 'payments',
    label: 'Top-ups and withdrawals',
    description:
      'Payment-gateway deposits and withdrawals created in the window, counted and summed per status, plus what is open right now whatever the window. Deposit statuses: pending, settled, failed, expired. Withdrawal statuses: pending, settled, failed, held (held = waiting for admin approval). Amounts in RM (MYR).',
    parameters: object({ ...windowProps, ...groupProp }, ['period']),
    // Gateway money: the payment screens' policy as well as the economy's.
    needs: [read('economy'), read('payment')],
    run: windowed('finance', 'payments'),
  },
  {
    name: 'pack_sales',
    label: 'Sales per pack',
    description:
      'Per-pack sales in the window: packs opened (paid with cash or bonus credit) and revenue (cash only, net of reversals), largest first. Bonus credit is not revenue, so a pack opened only with bonus credit shows its opens at RM 0: that is correct, not a fault. unattributed_revenue is pack spend from older rows that cannot be linked to a pack; total_revenue equals economy revenue. Amounts in RM (MYR).',
    parameters: object({ ...windowProps, ...groupProp }, ['period']),
    needs: [read('economy')],
    run: windowed('finance', 'pack-sales'),
  },
  {
    name: 'groups',
    label: 'Player groups',
    description:
      'The player groups and how many players each holds now (by current group). default_players counts players in no group other than DEFAULT. Use these names as the group argument of the other tools.',
    parameters: object({}),
    needs: [read('economy')],
    run: report('finance', 'groups'),
  },
  // One customer (the Support viewer's scope).
  {
    name: 'player',
    label: "A player's money",
    description:
      "One player's account by username (never email): join date, current player group, disabled flag, credit balance, vault cards and value, lifetime and last-30-days ledger totals (revenue = their pack spend, payouts = buybacks to them, cashout = their withdrawals as a signed sum, negative = taken from their wallet, pending ones included; their withdrawals by status say what was paid), and their deposits and withdrawals by status. last_30_days_window gives that rolling window's exact start and end as UTC instants; state it in Malaysia time. Amounts in RM (MYR).",
    parameters: object(
      {
        username: str(
          "The player's username as shown on their public profile, or their profile handle (the part after /profile/ in their link). If the reply has a lookup_note, tell staff what it says.",
        ),
      },
      ['username'],
    ),
    needs: [read('customer'), read('payment')],
    run: report('finance', 'player', (a) => ({ username: s(a.username) })),
  },
  {
    name: 'account',
    label: 'Account status',
    description:
      "One player's account status by shown name or profile handle (never email or phone): join date, disabled, frozen, phone verified yes/no, VIP level, paid pack pulls (lifetime and last 30 days; free and prize draws not counted), the last 5 delivery orders, and deposits and withdrawals created in the last 30 days by status. If the reply has a lookup_note, tell staff what it says. Amounts in RM (MYR).",
    parameters: object(
      {
        username: str(
          "The player's shown name, or their profile handle (the part after /profile/ in their link).",
        ),
      },
      ['username'],
    ),
    // It carries deposits and withdrawals: the payment screens' policy too.
    needs: [read('customer'), read('payment'), read('delivery_order')],
    run: report('support', 'account', (a) => ({ username: s(a.username) })),
  },
  {
    name: 'order',
    label: 'Delivery order',
    description:
      "One delivery order by the number the customer sees (like #A1B2C3) or its full id: status and the customer's wording for it, the player's shown name, the cards in it, tracking number, fees, when it was requested, shipped and completed, and staff status changes. If several orders share the number, all are listed. The delivery address and phone are not included. A tracking number in an unusual format is withheld (has_tracking_number says one exists).",
    parameters: object(
      {
        number: str(
          'The order number, like #A1B2C3 or A1B2C3, or the full order id.',
        ),
      },
      ['number'],
    ),
    needs: [read('delivery_order')],
    run: report('support', 'order', (a) => ({ number: s(a.number) })),
  },
  // Growth data.
  {
    name: 'challenge',
    label: 'Weekly challenge',
    description:
      "The Weekly Pulled Value Challenge. week current (default): the running week exactly as the public Ranks page shows it: the community pool, each stage with its threshold, whether it is unlocked and how much is still needed, each stage's prizes with the official card image link, the prizes the top 10 would get if the week ended now, and the live top-10 standings (shown name, profile handle, pulls, pulled value). Until the week ends, the top player is the current leader, not the winner. If hidden_players_above_cut is above 0, prizes are paid by original rank, so do not pair displayed ranks with prizes. week next: the next challenge waiting in the admin queue. Amounts in RM (MYR).",
    parameters: object(weekProp('the running week')),
    needs: [read('challenge')],
    run: report('growth', 'challenge', (a) => ({ week: s(a.week) })),
  },
  {
    name: 'challenge_results',
    label: "Last week's results",
    description:
      "Last week's Weekly Pulled Value Challenge result, exactly as settlement paid it: the week's dates, the pool and the stages it unlocked, and for each winner the paid rank, public name and profile handle, that week's pulled value, the cards they received (name, official image, quantity, today's value) and credits, and what the prize is worth today in total. Amounts in RM (MYR).",
    parameters: object({}),
    needs: [read('challenge')],
    run: report('growth', 'challenge-results'),
  },
  {
    name: 'signups',
    label: 'Sign-ups',
    description:
      'New player accounts per Malaysia day (days with none are left out), counted like the admin Stats page, plus first top-ups: players whose first-ever deposit settled in the window, whenever they signed up. The window must be 93 days or less; all_time is not allowed.',
    parameters: object(windowProps, ['period']),
    needs: [read('stats')],
    run: windowed('growth', 'signups', false),
  },
  {
    name: 'packs_opened',
    label: 'Packs opened',
    description:
      'Packs opened per Malaysia day (paid packs, plus free welcome packs counted separately; task and challenge prize draws are not counted) and the 10 most-opened packs, for one window and player group. The window must be 93 days or less; all_time is not allowed.',
    parameters: object({ ...windowProps, ...groupProp }, ['period']),
    needs: [read('stats')],
    run: windowed('growth', 'packs'),
  },
  {
    name: 'top_pulls',
    label: 'Top pulls',
    description:
      "One Malaysia day's most valuable paid pulls (default yesterday, top 10): rank, when, the card (name, grade, set, tier, slab image), the pack, the pulled value in RM and the player's public name and profile handle. Free welcome packs and prize draws are not counted; disabled players are left out. Use it for 'who pulled the most expensive card today/yesterday'.",
    parameters: object({
      day: str('The Malaysia day, YYYY-MM-DD. Default: yesterday.'),
      limit: int('How many pulls. Default 10.', 1, 20),
    }),
    needs: [read('stats')],
    run: report('growth', 'top-pulls', (a) => ({
      day: s(a.day),
      limit: n(a.limit),
    })),
  },
  {
    name: 'tasks',
    label: 'Tasks and achievements',
    description:
      "The weekly tasks and achievements exactly as the /task page shows them: each task's title, what it asks for (requirement; level = the VIP level a reach_level achievement needs), its prize, what the page says the prize is worth (value_myr), the prize's picture link and when the task stops showing. Weekly tasks reset every Monday 00:00 Malaysia time. week next: the tasks already switched on for next week. Amounts in RM (MYR).",
    parameters: object(weekProp("this week's tasks")),
    needs: [read('task')],
    run: report('growth', 'tasks', (a) =>
      s(a.week) ? { week: s(a.week) } : {},
    ),
  },
  // Store and stock.
  {
    name: 'packs',
    label: 'Packs',
    description:
      "Every pack with the numbers the admin pack list shows: title, category, status, whether it is listed publicly, whether it is sold out (still listed, but paid opens are refused), price, buyback %, pool mix (RAW, GRADED or MIX), the published tier odds with their EV and RTP, and the real EV and RTP of odds set 1 (what the DEFAULT group plays) at today's card prices. Amounts in RM (MYR).",
    parameters: object({}),
    needs: [read('pack')],
    run: report('store', 'packs'),
  },
  {
    name: 'pack',
    label: 'One pack',
    description:
      'One pack by slug (drafts included): the same numbers as packs, plus its pool by rarity (cards, average display price, cards with no stock left, cards with untracked stock) and its top hits with their display price and stock on hand. Never per-card win chances.',
    parameters: object({ slug: str('The pack slug, like silver-pack.') }, [
      'slug',
    ]),
    needs: [read('pack')],
    run: report('store', 'pack', (a) => ({ slug: s(a.slug) })),
  },
  {
    name: 'low_stock',
    label: 'Low stock',
    description:
      'Cards whose tracked stock on hand is at or below max (default 0; below 0 = units owed to winners): matching_cards and owed (cards and units) count all of them, and cards lists the lowest ones first, with the active packs that can still draw them, plus the sold-out packs. Give the counts, not the length of the list. A card at 0 can still be drawn (buyback covers it). Cards with untracked stock are not listed.',
    parameters: object({
      max: int(
        'List cards with on_hand at or below this. Default 0; -1 = only cards owed to winners.',
      ),
      limit: int('How many cards to list, lowest first. Default 50.', 1, 200),
    }),
    needs: [read('inventory')],
    run: report('store', 'stock', (a) => ({
      max: n(a.max),
      limit: n(a.limit),
    })),
  },
  // Any admin screen, as the asker.
  {
    name: 'admin_read',
    label: 'Admin screen',
    description:
      "Read an admin dashboard screen as the person asking: the same data their admin login shows, read-only, for anything the other tools do not cover. A screen their role cannot open answers 'No access': tell them so plainly, never guess the figure. path is the admin API path; put filters in params (limit and offset on lists, q to search, fields to pick columns on core screens). Useful paths: stock /admin/inventory (q=card name), /admin/inventory/{handle}, /admin/procurement/to-buy (the purchasing list: card, qty to buy, on hand, PriceCharting price, picture), /admin/procurement/to-ship (parcels to post), /admin/goods-receive-notes, /admin/purchase-invoices; orders /admin/delivery-orders (status=requested|processed|ready_to_ship|shipped), /admin/delivery-orders/{id}; automation /admin/automation; customers /admin/customers (q=search), /admin/customers/{id}, /admin/customers/{id}/transactions, /admin/customers/{id}/pulls, /admin/players (q=username); packs and cards /admin/packs, /admin/packs/{slug}, /admin/cards/{handle}, /admin/pulls; money /admin/economy, /admin/ledger, /admin/stats, /admin/payments/deposits (status=settled for real top-ups), /admin/payments/withdrawals; challenge /admin/challenge/stages, /admin/challenge/schedule, /admin/challenge/winners; tasks /admin/tasks, /admin/vip-levels. Not open: staff invites, API keys, PriceCharting lookups, file exports. Passwords and secrets come back as [hidden]. An answer over 40,000 characters comes back cut (truncated: true): ask again narrower.",
    parameters: object(
      {
        path: str(
          'The admin API path, starting /admin/, like /admin/inventory.',
        ),
        params: {
          type: 'object',
          description:
            'Filters for that screen, like {"q": "Pikachu", "limit": 20}.',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
        },
      },
      ['path'],
    ),
    needs: [read('assistant_browse')],
    run: async (args, ctx) =>
      JSON.stringify(
        await adminReadAs({
          container: ctx.container,
          port: ctx.port,
          access: ctx.access,
          signal: ctx.signal,
          path: args.path,
          params:
            args.params && typeof args.params === 'object'
              ? (args.params as Record<string, string | number | boolean>)
              : {},
        }),
      ),
  },
  // Raw SQL: past every screen's RBAC, so super admins only.
  {
    name: 'db_query',
    label: 'Database query',
    description:
      "Run one read-only SQL query (PostgreSQL 16) on the live Polycards database, for any question the reports and admin screens do not answer directly (profit and margins, cohorts, one player's full history, rankings like the top 10 single top-ups). SELECT or WITH only; it runs in a read-only transaction, stops after 20 seconds and returns at most 500 rows, so aggregate in SQL (COUNT, SUM, GROUP BY) and name every output column. Times are stored in UTC: created_at AT TIME ZONE 'Asia/Kuala_Lumpur' gives Malaysia time. Soft-deleted rows have deleted_at set: add deleted_at IS NULL. Before filtering on a status, reason, type or source column, list its values with SELECT DISTINCT. The DEFAULT group = players in no customer_group other than DEFAULT. Money: credit_transaction.amount includes spend-only bonus credit, so never SUM(amount) for cash: a row's cash in sen is ROUND(amount * 100) - COALESCE(bonus_cents, 0); revenue = minus its sum over reason 'pack_open' and payouts = its sum over 'buyback', as the Economy page counts; bonus_grant, reward_credit, voucher_claim, daily_reward and referral_commission are promo credit, never revenue. Paid pulls: pull.source IN ('pack', 'bonus'); a pull's cash share is (10000 - bonus_bp) / 10000.0. Joins: pull.pack_id holds the pack's slug, not its id, so JOIN pack ON pack.slug = pull.pack_id (joining on pack.id finds nothing; 'task-reward' and 'challenge-...' pulls have no pack row); a 'pack_open' charge links to its pulls by credit_transaction.source_transaction_id = pull.open_id. Main tables: customer (players: email, phone, metadata->>'handle', has_account), customer_account_state, credit_transaction (the wallet in RM: amount, reason), ledger_entry (type, wallet_delta, vault_delta), gateway_deposit (status, amount_requested, amount_settled, payment_method_code, gateway), gateway_withdrawal (status, failure_reason), pull (customer_id, pack_id, card_id, source, status, buyback_amount in RM, recorded_value_usd), pack (slug, title, price in RM, buyback_percent, status), pack_odds, card (name, grade, market_value in USD; fx_rate converts), delivery_order and delivery_order_item, challenge_stage, challenge_schedule, challenge_payout, task_definition, task_claim, daily_checkin, vip_level, vip_member_state, referral_attribution, weekly_settlement(_line), player_payout_details, admin_action_audit, customer_group and customer_group_customer, purchase_invoice, goods_receive_note, stock_movement. A table's columns: SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'pull'.",
    parameters: object(
      {
        sql: str(
          'One SELECT (or WITH ... SELECT) query, up to 8,000 characters.',
        ),
      },
      ['sql'],
    ),
    needs: ['super_admin'],
    run: async (args, ctx) =>
      JSON.stringify(
        await callReport({
          port: ctx.port,
          desk: 'admin',
          path: 'sql',
          signal: ctx.signal,
          userId: ctx.access.userId,
          post: { sql: args.sql },
          timeoutMs: 60_000,
        }),
      ),
  },
  // Posters (live data, the site's design) and AI images.
  {
    name: 'challenge_poster',
    label: 'Challenge poster',
    description:
      'A finished Weekly Pulled Value Challenge poster of ONE stage (1080x1350) from live data with the official card art: the unlock headline, the stage chips and the podium prizes of one stage (default: the highest unlocked stage), optionally with the current top-3 leaders. While a stage is still locked it also shows the pool on its way to the next stage: for a "stage 1 unlocked, on to stage 2" post, feature stage 2. week next draws the next queued challenge. A promo of a whole week (the 4 stages, 推广图) is challenge_stages_poster, not this.',
    parameters: object({
      ...weekProp('the running week'),
      stage: int(
        'Which stage prizes to feature. Default: the highest unlocked stage.',
        1,
      ),
      leaders: {
        type: 'boolean',
        description: 'true adds the current top-3 leaders. Default false.',
      },
    }),
    needs: [IMAGES, read('challenge')],
    run: poster('challenge-poster', (a) => ({
      stage: n(a.stage),
      leaders: b(a.leaders) === undefined ? undefined : b(a.leaders) ? 1 : 0,
      week: s(a.week),
    })),
  },
  {
    name: 'challenge_stages_poster',
    label: 'Challenge stages poster',
    description:
      "A finished poster of every stage of the Weekly Pulled Value Challenge on one image (1080x1350): each stage's unlock threshold, its #1 to #3 prizes as the official card art with today's value, and what ranks 4 to 10 win. Stages still locked show dimmed. week next: the next queued challenge. This is THE weekly challenge promo (推广图): use it whenever staff ask for the week's or next week's challenge poster, unless they name one stage.",
    parameters: object(weekProp('the running week')),
    needs: [IMAGES, read('challenge')],
    run: poster(
      'challenge-stages-poster',
      (a) => ({ week: s(a.week) }),
      'stage:rank',
    ),
  },
  {
    name: 'challenge_results_poster',
    label: 'Results poster',
    description:
      'The results of the most recently settled Weekly Challenge week as two posting images (1080x1350): part top (default) = the top 3 with every prize card they won; part rest = ranks 4 to 10. Make both for a results post (top first).',
    parameters: object({
      part: oneOf(
        ['top', 'rest'],
        'top (default): the top 3. rest: ranks 4-10.',
      ),
    }),
    needs: [IMAGES, read('challenge')],
    run: poster('challenge-results-poster', (a) => ({ part: s(a.part) })),
  },
  {
    name: 'challenge_standings_poster',
    label: 'Standings poster',
    description:
      'Who is leading the RUNNING Weekly Pulled Value Challenge, as two posting images (1080x1350): part top (default) = the current top 3 with the cards they would win; part rest = ranks 4 to 10. It is live, so call them leaders, never winners. Use it for the Friday who-is-leading post.',
    parameters: object({
      part: oneOf(
        ['top', 'rest'],
        'top (default): the top 3. rest: ranks 4-10.',
      ),
    }),
    needs: [IMAGES, read('challenge')],
    run: poster('challenge-standings-poster', (a) => ({ part: s(a.part) })),
  },
  {
    name: 'brand_poster',
    label: 'Brand poster',
    description:
      "A finished post graphic in the website's home-hero design for milestones, sign-ups and announcements (1080x1350): logo, eyebrow, an optional live figure, a big sentence-case headline, a quiet line, the Open a pack pill and the site's top 3 chase cards. Text is English letters only (no Chinese, no digits typed in): a figure comes only from metric, live. players = every registered player ever; new_players = sign-ups in the last `days` days; packs_opened = paid packs since launch. When staff ask for a number the live figure has not reached (1,000 when 485 signed up), pass it as goal: the poster shows 'Road to 1,000' with live progress.",
    parameters: object(
      {
        headline: str(
          'The claim in English, sentence case ("Collectors and counting."), up to 60 characters, no digits.',
        ),
        kicker: str(
          'Optional eyebrow, up to 28 characters, e.g. "Community milestone".',
        ),
        subline: str('Optional quiet line, up to 120 characters.'),
        metric: oneOf(
          ['none', 'players', 'new_players', 'packs_opened'],
          'The live figure to show. Default none.',
        ),
        goal: int('A target for the metric, e.g. 1000.', 10, 10_000_000),
        days: int('new_players only: how many days back. Default 3.', 1, 93),
        round: oneOf(
          ['exact', 'hundred'],
          'exact (default) or hundred: rounded down, like 400+.',
        ),
        art: oneOf(
          ['top_hits', 'none'],
          'top_hits (default): the top 3 chase cards; none: type only.',
        ),
      },
      ['headline'],
    ),
    needs: [IMAGES, read('stats')],
    run: poster(
      'brand-poster',
      (a) => ({
        headline: s(a.headline),
        kicker: s(a.kicker),
        subline: s(a.subline),
        metric: s(a.metric),
        goal: n(a.goal),
        days: n(a.days),
        round: s(a.round),
        art: s(a.art),
      }),
      'hero card',
    ),
  },
  {
    name: 'achievements_poster',
    label: 'Achievements poster',
    description:
      "A finished poster of the VIP-level achievements ladder (1080x1350): one tile per level with the prize's official picture, its name and what /task says it is worth. Default: every live VIP-level achievement (a poster fits 10); min_level and max_level narrow it, e.g. 60 to 100.",
    parameters: object({
      min_level: int('The lowest VIP level to show.', 1, 100),
      max_level: int('The highest VIP level to show.', 1, 100),
    }),
    needs: [IMAGES, read('task')],
    run: poster(
      'achievements-poster',
      (a) => ({ min_level: n(a.min_level), max_level: n(a.max_level) }),
      'level',
    ),
  },
  {
    name: 'tasks_poster',
    label: 'Tasks poster',
    description:
      "A finished poster of this week's tasks as the /task page shows them (1080x1350): the daily check-in strip, then one tile per other weekly task with its prize and value. week next draws next week's tasks (use it for dates after this Sunday).",
    parameters: object(weekProp("this week's tasks")),
    needs: [IMAGES, read('task')],
    run: poster('tasks-poster', (a) => ({ week: s(a.week) }), 'prize'),
  },
  {
    name: 'top_pulls_poster',
    label: 'Top pulls poster',
    description:
      "A finished poster of one Malaysia day's top paid pulls (default yesterday, top 10) in the website's design (1080x1350): each card's official slab, rank, the player's public name and the pulled value. Use it for any post about top hits or the day's best cards.",
    parameters: object({
      day: str('The Malaysia day, YYYY-MM-DD. Default: yesterday.'),
      limit: int('How many pulls on the poster. Default 10.', 1, 10),
    }),
    needs: [IMAGES, read('stats')],
    run: poster(
      'top-pulls-poster',
      (a) => ({ day: s(a.day), limit: n(a.limit) }),
      'rank',
    ),
  },
  {
    name: 'brand_logo',
    label: 'Logo',
    description:
      'The official Polycards wordmark (white on transparent, 360x97 PNG), shown in the chat to download. Never draw or imitate the logo with image generation; generated images get it added automatically.',
    parameters: object({}),
    needs: [IMAGES],
    run: async (_args, ctx) => {
      await ctx.showImage(
        Buffer.from(BRAND_LOGO_B64, 'base64'),
        'polycards-logo.png',
        'image/png',
      );
      return 'The official wordmark is shown in the chat. Use it unchanged.';
    },
  },
  {
    name: 'marketing_poster',
    label: 'Marketing poster',
    description:
      "A finished post in Polycards' Instagram design (1080x1350): new AI key art in the house look (matte black, champagne-gold light, one hero object, matched to the brand's own past posts) with the brand's real type drawn over it — the logo top-left, polycards.gg top-right, a spaced gold eyebrow between two gold lines, a big Nekst headline (chosen words in gold), an optional quiet line and the white Open a pack button. Use it for announcements, promos, events and launches that need new art. Write copy like the posted posters: headline short and punchy, usually ALL CAPS (LOSSLESS MODE, 3 CURRENCIES, EARN UP TO) or two short sentence-case lines (Real cards. Real pulls.); eyebrow a short context line (Every Saturday & Sunday, Top up your way, New pack · Out now); gold = the words to light in gold (often the number or offer). Copy only what staff stated: never invent offers, numbers or dates. English letters and digits only on the image: Chinese goes in the caption. For live challenge, tasks, top pulls, achievements or sign-up figures use those data posters instead.",
    parameters: object(
      {
        scene: str(
          'What the key art shows, in English: one hero object and its setting, e.g. "a single glowing gold ring floating above a glossy black floor". No text, no people, no Pokémon.',
        ),
        headline: str(
          'The big line, up to 40 characters, English letters and digits only.',
        ),
        eyebrow: str(
          'Optional small line above the headline, up to 28 characters.',
        ),
        gold: str(
          'Optional: words of the headline to draw in gold, e.g. "100% BUYBACK".',
        ),
        subline: str(
          'Optional quiet line near the bottom, up to 120 characters.',
        ),
        corner: str(
          'Optional top-right text: polycards.gg (default) or one of its pages, e.g. polycards.gg/referral.',
        ),
        button: {
          type: 'boolean',
          description: 'false: leave off the Open a pack button. Default true.',
        },
        use_attached: {
          type: 'boolean',
          description:
            'true: also show the image model the screenshots attached to this message (e.g. a pack to feature).',
        },
        feature_url: str(
          'Optional: a real pack or slab image URL from find_assets, stood unchanged in the middle of the poster. Then describe the scene as an EMPTY stage for it (a glowing plinth, a gold ring, an arch of light) with the centre left clear.',
        ),
        reference_urls: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional: up to 4 image URLs (find_assets, search_chats) the image model should follow for content, e.g. a past poster to vary.',
        },
      },
      ['scene', 'headline'],
    ),
    needs: [IMAGES],
    run: async (args, ctx) => {
      const scene = s(args.scene);
      if (!scene) throw new Error('scene is required.');
      const copy: PosterCopy = {
        headline: s(args.headline) ?? '',
        eyebrow: s(args.eyebrow),
        gold: s(args.gold),
        subline: s(args.subline),
        corner: s(args.corner),
        button: b(args.button) !== false,
      };
      // Checked before the image is paid for.
      const bad = posterCopyError(copy);
      if (bad) throw new Error(bad);
      const featureUrl = s(args.feature_url);
      // Loaded before the image is paid for: a bad URL fails first.
      const feature = featureUrl
        ? await assetBytes(featureUrl, ctx.container)
        : undefined;
      const attached = [
        ...(b(args.use_attached) ? ctx.attachments : []),
        ...(await assetDataUrls(args.reference_urls, ctx.container)),
      ];
      const { buffer, cost } = await generateImage({
        key: ctx.openrouterKey,
        model: ctx.imageModel,
        prompt: artPrompt(
          feature
            ? `${scene} Leave the centre of the image clear and empty: a real product will be placed there later, so draw only its stage.`
            : scene,
          ctx.imageStyle,
          ctx.styleRefs.length,
          attached.length,
        ),
        references: [...ctx.styleRefs, ...attached],
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]),
      });
      ctx.addCost(cost);
      await ctx.showImage(
        await composePoster(buffer, copy, feature),
        'poster.jpg',
        'image/jpeg',
      );
      return 'The poster is shown in the chat with a download button: new key art in the brand look with the brand type. Give a one-line description and offer a caption (English, plus Chinese if staff write Chinese). It is a draft for a human to review.';
    },
  },
  {
    name: 'generate_image',
    label: 'AI image',
    description:
      "Draw a new image with the AI image model, in Polycards' house look by default (matte black, champagne-gold light, cinematic, matched to the brand's own past posts), fitted to 1080x1350 with the official logo added (logo false leaves it off). Use it for art without words: pack designs, backgrounds, key art. For a post with a headline use marketing_poster instead, and for posters with live figures, prizes or winners use the data poster tools. Describe the scene in detail in English. brand_style false drops the house look when staff ask for something else. use_attached true passes the screenshots attached to this message. Image models refuse brand-specific prompts (Pokémon names): describe generic collecting scenes instead.",
    parameters: object(
      {
        prompt: str('What to draw, in detail, in English.'),
        use_attached: {
          type: 'boolean',
          description: 'true: use the attached screenshots as references.',
        },
        logo: {
          type: 'boolean',
          description: 'false: leave the logo off. Default true.',
        },
        brand_style: {
          type: 'boolean',
          description:
            'false: no house look, draw exactly the prompt. Default true.',
        },
        reference_urls: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional: up to 4 image URLs (find_assets, search_chats) to follow for content: a pack or card to show, or a past image to vary.',
        },
      },
      ['prompt'],
    ),
    needs: [IMAGES],
    run: async (args, ctx) => {
      const prompt = s(args.prompt);
      if (!prompt) throw new Error('prompt is required.');
      const attached = [
        ...(b(args.use_attached) ? ctx.attachments : []),
        ...(await assetDataUrls(args.reference_urls, ctx.container)),
      ];
      const brand = b(args.brand_style) !== false;
      const refs = brand ? ctx.styleRefs : [];
      const { buffer, cost } = await generateImage({
        key: ctx.openrouterKey,
        model: ctx.imageModel,
        prompt: brand
          ? artPrompt(prompt, ctx.imageStyle, refs.length, attached.length)
          : prompt,
        references: [...refs, ...attached],
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]),
      });
      ctx.addCost(cost);
      const out = await brandImage(buffer, b(args.logo) !== false);
      await ctx.showImage(out, 'ai-image.jpg', 'image/jpeg');
      return 'The image is shown in the chat with a download button. Describe it in one line; it is a draft for a human to review.';
    },
  },
  // Memory, past chats and assets (agent-tools.ts).
  ...AGENT_TOOLS,
];

export const toolSpecs = (tools: AssistantTool[]) =>
  tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
