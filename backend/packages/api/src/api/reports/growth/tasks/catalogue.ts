import { MedusaError } from '@medusajs/framework/utils';
import type PacksModuleService from '../../../../modules/packs/service';
import { posterRm } from '../../../../modules/packs/brand-poster';
import { ticketsSuffix } from '../../../../modules/packs/lucky-draw';
import { taskWeekFor } from '../../../../modules/packs/referral';
import type {
  HubReward,
  TaskKind,
  TaskRequirement,
} from '../../../../modules/packs/tasks';
import { resolveTaskLabels } from '../../../admin/tasks/labels';

export type CatalogueTask = {
  title: string;
  /** In plain English, as the admin Tasks console words it. */
  requirement: string;
  /** The VIP level a reach_level achievement asks for; null otherwise. */
  level: number | null;
  /** The check-in days a checkin_days task asks for; null otherwise. */
  checkin_days: number | null;
  /** As the /task page words it: 'Free rip · Silver Pack', plus
   *  ' + 50 Lucky Draw tickets' when the task also pays tickets. */
  prize: string;
  prize_type: HubReward['type'];
  /** Lucky Draw tickets a claim also pays (0 = none); already in `prize`. */
  tickets: number;
  /** What /task says it is worth: the credit, the pack price, the card's
   *  display price today; null when the pack or card is gone. */
  value_myr: number | null;
  /** The prize's official picture as stored (often storefront-relative,
   *  which is what fetchBytes resolves itself); null for a credit, or a
   *  pack/card with no product shot (never the pack page's factory hero). */
  image: string | null;
  ends_at: string | null;
};

/** The prize as the /task page words it (task-hub.ts rewardLabel), so a
 *  post and the page a player opens from it say the same thing. A pack or
 *  card that no longer exists is marked for staff, as the admin console
 *  marks it, because nobody can claim it. */
export function prizeLabel(
  reward: HubReward,
  tickets = 0,
): {
  prize: string;
  value_myr: number | null;
} {
  const { prize, value_myr } = rewardPrize(reward);
  return { prize: prize + ticketsSuffix(tickets), value_myr };
}

function rewardPrize(reward: HubReward): {
  prize: string;
  value_myr: number | null;
} {
  if (reward.type === 'credit') {
    return {
      prize: `${posterRm(reward.amount_myr)} bonus credit`,
      value_myr: reward.amount_myr,
    };
  }
  if (reward.type === 'pack') {
    return {
      prize: `Free rip · ${reward.pack_title ?? `${reward.pack_id} (missing)`}`,
      value_myr: reward.pack_price_myr,
    };
  }
  if (!reward.card_name) {
    return { prize: `Card · ${reward.card_handle} (missing)`, value_myr: null };
  }
  return {
    prize: reward.card_grade
      ? `${reward.card_name} · ${reward.card_grade}`
      : reward.card_name,
    value_myr: reward.card_value_myr,
  };
}

/** The instant a report reads the catalogue at: now for `week` current (the
 *  default), next Monday 00:00 MYT for next, so staff can draw the coming
 *  week's tasks before it starts (any task switched on whose run window
 *  covers that instant). */
export function catalogueAt(week: unknown, now = new Date()): Date {
  if (week === undefined || week === 'current') return now;
  if (week === 'next') return taskWeekFor(now).endUtcExcl;
  throw new MedusaError(
    MedusaError.Types.INVALID_DATA,
    "week must be current (this week's tasks) or next (the tasks switched on for next week, from Monday 00:00 Malaysia time).",
  );
}

// No customer has this id. Reward resolution in taskHubFor does not depend
// on the customer, so reading the hub as nobody gives the live catalogue
// exactly as /task shows it, with the same prices, and no one's progress.
const NOBODY = 'report:catalogue';

/** Every task the /task page shows right now (switched on and inside its run
 *  window), with its prize, today's value and the prize's picture.
 *  Achievements climb by VIP level (the rest after them by title); weekly
 *  tasks run by when they end. */
export async function taskCatalogue(
  packs: PacksModuleService,
  now = new Date(),
): Promise<{
  week_start: string;
  tasks: (CatalogueTask & { kind: TaskKind })[];
}> {
  const hub = await packs.taskHubFor({ customerId: NOBODY, now });
  if (!hub.tasks.length) return { week_start: hub.week_start, tasks: [] };
  const ids = hub.tasks.map((t) => t.id);
  const [labels, defs] = await Promise.all([
    resolveTaskLabels(packs, hub.tasks),
    packs.listTaskDefinitions(
      { id: ids },
      { select: ['id', 'ends_at'], take: ids.length },
    ),
  ]);
  const endsAt = new Map(defs.map((d) => [d.id, d.ends_at]));
  const tasks = hub.tasks.map((t) => {
    const requirement = t.requirement as TaskRequirement;
    const ends = endsAt.get(t.id);
    return {
      kind: t.kind,
      title: t.title,
      requirement: labels.get(t.id)!.requirement,
      level: requirement.type === 'reach_level' ? requirement.level : null,
      checkin_days:
        requirement.type === 'checkin_days' ? requirement.days : null,
      ...prizeLabel(t.reward, t.tickets),
      prize_type: t.reward.type,
      tickets: t.tickets,
      // The hub already resolved the prize's picture (the pack's product
      // shot; slab, else raw scan) — the same one /task shows on the task.
      image:
        t.reward.type === 'pack'
          ? t.reward.pack_image
          : t.reward.type === 'card'
            ? t.reward.card_image
            : null,
      ends_at: ends ? new Date(ends).toISOString() : null,
    };
  });
  const order = (t: (typeof tasks)[number]): [number, string] =>
    t.kind === 'achievement'
      ? [t.level ?? Number.MAX_SAFE_INTEGER, t.title]
      : [t.ends_at ? Date.parse(t.ends_at) : Number.MAX_SAFE_INTEGER, t.title];
  tasks.sort((a, b) => {
    const [an, at] = order(a);
    const [bn, bt] = order(b);
    return an - bn || at.localeCompare(bt);
  });
  return { week_start: hub.week_start, tasks };
}
