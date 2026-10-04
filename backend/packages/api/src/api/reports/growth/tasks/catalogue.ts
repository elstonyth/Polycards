import type PacksModuleService from '../../../../modules/packs/service';
import { posterRm } from '../../../../modules/packs/brand-poster';
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
  /** As the /task page words it: 'Free rip · Silver Pack'. */
  prize: string;
  prize_type: HubReward['type'];
  /** What /task says it is worth: the credit, the pack price, the card's
   *  display price today; null when the pack or card is gone. */
  value_myr: number | null;
  /** The prize's official picture as stored (often storefront-relative,
   *  which is what fetchBytes resolves itself); null for a credit. */
  image: string | null;
  ends_at: string | null;
};

/** The prize as the /task page words it (TaskHubClient rewardLabel), so a
 *  post and the page a player opens from it say the same thing. A pack or
 *  card that no longer exists is marked for staff, as the admin console
 *  marks it, because nobody can claim it. */
export function prizeLabel(reward: HubReward): {
  prize: string;
  value_myr: number | null;
} {
  if (reward.type === 'credit') {
    return {
      prize: `${posterRm(reward.amount_myr)} credit`,
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
  const packSlugs = hub.tasks.flatMap((t) =>
    t.reward.type === 'pack' ? [t.reward.pack_id] : [],
  );
  const cardHandles = hub.tasks.flatMap((t) =>
    t.reward.type === 'card' ? [t.reward.card_handle] : [],
  );
  const [labels, defs, packRows, cardRows] = await Promise.all([
    resolveTaskLabels(packs, hub.tasks),
    packs.listTaskDefinitions(
      { id: ids },
      { select: ['id', 'ends_at'], take: ids.length },
    ),
    packSlugs.length
      ? packs.listPacks(
          { slug: packSlugs },
          {
            select: ['slug', 'image', 'display_image'],
            take: packSlugs.length,
          },
        )
      : Promise.resolve([]),
    cardHandles.length
      ? packs.listCards(
          { handle: cardHandles },
          {
            select: ['handle', 'image', 'slab_image'],
            take: cardHandles.length,
          },
        )
      : Promise.resolve([]),
  ]);
  const endsAt = new Map(defs.map((d) => [d.id, d.ends_at]));
  const packArt = new Map(
    packRows.map((p) => [p.slug, p.image || p.display_image]),
  );
  const cardArt = new Map(
    cardRows.map((c) => [c.handle, c.slab_image || c.image]),
  );
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
      ...prizeLabel(t.reward),
      prize_type: t.reward.type,
      image:
        (t.reward.type === 'pack'
          ? packArt.get(t.reward.pack_id)
          : t.reward.type === 'card'
            ? cardArt.get(t.reward.card_handle)
            : null) || null,
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
