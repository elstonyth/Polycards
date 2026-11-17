import type { Need } from '../access';
import { LASTING_WRITES } from '../access';
import { scheduledRunAllows } from '../confirm';
import { TOOLS } from '../tools';

// Every assistant tool's policy as it stands (2026-11-17): what the asker's
// roles must hold, whether the engine refuses it once any tool output is in
// the turn (a lasting write), and whether a scheduled run (nobody to tap)
// gets it. A new tool fails here until it is classified.

type Row = {
  needs: string[];
  refusedAfterOutsideRead: boolean;
  scheduledRun: boolean;
};

const read = (...needs: string[]): Row => ({
  needs,
  refusedAfterOutsideRead: false,
  scheduledRun: true,
});
const IMG = 'assistant_image:create';
const USE = 'assistant:update';
const UNBAN = 'assistant_unban:update';

const POLICY: Record<string, Row> = {
  economy: read('economy:read'),
  daily_economy: read('economy:read'),
  payments: read('economy:read', 'payment:read'),
  pack_sales: read('economy:read'),
  groups: read('economy:read'),
  player: read('customer:read', 'payment:read'),
  account: read('customer:read', 'payment:read', 'delivery_order:read'),
  ban_reason: read('customer:read', 'payment:read'),
  order: read('delivery_order:read'),
  challenge: read('challenge:read'),
  challenge_results: read('challenge:read'),
  signups: read('stats:read'),
  packs_opened: read('stats:read'),
  top_pulls: read('stats:read'),
  tasks: read('task:read'),
  packs: read('pack:read'),
  pack: read('pack:read'),
  low_stock: read('inventory:read'),
  admin_read: read('assistant_browse:read'),
  db_query: read('super_admin'),
  challenge_poster: read(IMG, 'challenge:read'),
  challenge_stages_poster: read(IMG, 'challenge:read'),
  challenge_results_poster: read(IMG, 'challenge:read'),
  challenge_standings_poster: read(IMG, 'challenge:read'),
  brand_poster: read(IMG, 'stats:read'),
  achievements_poster: read(IMG, 'task:read'),
  tasks_poster: read(IMG, 'task:read'),
  top_pulls_poster: read(IMG, 'stats:read'),
  brand_logo: read(IMG),
  marketing_poster: read(IMG),
  generate_image: read(IMG),
  // Bank changes: a card to tap, never in a scheduled run. The engine does
  // not refuse them after outside reads: staff-text matching and the tap are
  // their guard.
  unban_account: {
    needs: [UNBAN],
    refusedAfterOutsideRead: false,
    scheduledRun: false,
  },
  unban_bank_number: {
    needs: [UNBAN],
    refusedAfterOutsideRead: false,
    scheduledRun: false,
  },
  bank_save_check: read('customer:read', 'payment:read'),
  account_links: read('customer:read'),
  free_bank_number: {
    needs: [UNBAN, 'customer:update'],
    refusedAfterOutsideRead: false,
    scheduledRun: false,
  },
  clear_name_clash: {
    needs: [UNBAN, 'customer:update'],
    refusedAfterOutsideRead: false,
    scheduledRun: false,
  },
  // Lasting writes: only before any tool output, never in a scheduled run.
  remember: {
    needs: [USE],
    refusedAfterOutsideRead: true,
    scheduledRun: false,
  },
  recall: read(USE),
  // Deletes at once (its own, or by an id the admin typed): no tap.
  forget: {
    needs: [USE],
    refusedAfterOutsideRead: true,
    scheduledRun: false,
  },
  search_chats: read(USE),
  find_assets: read(IMG, 'pack:read'),
  schedule_task: {
    needs: [USE],
    refusedAfterOutsideRead: true,
    scheduledRun: false,
  },
  list_schedules: read(USE),
  cancel_schedule: {
    needs: [USE],
    refusedAfterOutsideRead: true,
    scheduledRun: false,
  },
};

const needText = (n: Need) =>
  n === 'super_admin' ? n : `${n.resource}:${n.operation}`;

describe('assistant tool policy', () => {
  it('classifies every tool, and only those', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      Object.keys(POLICY).sort(),
    );
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s', (name, tool) => {
    const want = POLICY[name];
    expect({
      needs: tool.needs.map(needText),
      refusedAfterOutsideRead: LASTING_WRITES.has(tool.name),
      scheduledRun: scheduledRunAllows(tool),
    }).toEqual({
      needs: want.needs,
      refusedAfterOutsideRead: want.refusedAfterOutsideRead,
      scheduledRun: want.scheduledRun,
    });
  });
});
