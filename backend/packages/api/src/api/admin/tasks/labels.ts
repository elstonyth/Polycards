import type PacksModuleService from '../../../modules/packs/service';
import { cardValueMyr } from '../../../modules/packs/service';
import { ticketsLabel, ticketsSuffix } from '../../../modules/packs/lucky-draw';
import { asPixelPokemonCrud } from '../../../modules/packs/pixel-pokemon-service';
import { resolveFxRate } from '../../../modules/packs/pricing';
import { FREE_WELCOME_CATEGORY } from '../../../modules/packs/free-pack';
import { REWARD_BOX_CATEGORY } from '../../../modules/packs/lossless';
import type {
  TaskKind,
  TaskRequirement,
  TaskReward,
} from '../../../modules/packs/tasks';

/**
 * Plain-English labels for the admin Tasks console.
 *
 * Resolved on the SERVER, deliberately. The console needs a pack title, a card
 * name and a pixel Pokémon name to render a task legibly, and the alternative
 * was fetching those three catalogs into the browser: `usePacks` fans out to
 * every odds + card row to compute EV/RTP, and `useCards` is the unpaginated
 * whole catalog — a lot of work for three string lookups. Here the cost is
 * bounded by the number of TASKS (capped at 500), not by catalog size.
 *
 * A dangling reference is NAMED, never hidden: a task pointing at a deleted
 * pack reads "Free rip · bronze-pack (missing)" rather than silently rendering
 * the raw slug, because that task will fail at claim time for every customer
 * who completes it.
 */

export interface TaskLabels {
  requirement: string;
  reward: string;
}

const rm = (n: number): string =>
  `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** Everything the labeller needs to look up, gathered in one pass. */
interface Refs {
  packSlugs: Set<string>;
  cardHandles: Set<string>;
  pixelIds: Set<string>;
}

const collect = (
  rows: { requirement: unknown; reward: unknown }[],
): Refs => {
  const refs: Refs = {
    packSlugs: new Set(),
    cardHandles: new Set(),
    pixelIds: new Set(),
  };
  for (const row of rows) {
    const req = row.requirement as Partial<TaskRequirement> & {
      pack_id?: string | null;
      pixel_pokemon_id?: string | null;
    };
    const rew = row.reward as Partial<TaskReward> & {
      pack_id?: string;
      card_handle?: string;
    };
    if (typeof req?.pack_id === 'string' && req.pack_id)
      refs.packSlugs.add(req.pack_id);
    if (typeof req?.pixel_pokemon_id === 'string' && req.pixel_pokemon_id)
      refs.pixelIds.add(req.pixel_pokemon_id);
    if (rew?.type === 'pack' && typeof rew.pack_id === 'string')
      refs.packSlugs.add(rew.pack_id);
    if (rew?.type === 'card' && typeof rew.card_handle === 'string')
      refs.cardHandles.add(rew.card_handle);
  }
  return refs;
};

/** `id` when the row is gone — with the marker that makes it actionable. */
const name = (map: Map<string, string>, id: string): string =>
  map.get(id) ?? `${id} (missing)`;

export async function resolveTaskLabels(
  packs: PacksModuleService,
  rows: {
    id: string;
    /** Picks "today" / "this week" / lifetime wording. Absent = the
     *  pre-daily reading, where the goal type alone implied the cadence. */
    kind?: string;
    requirement: unknown;
    reward: unknown;
    /** Lucky Draw tickets the claim also pays; > 0 is appended to the reward. */
    tickets?: number;
  }[],
): Promise<Map<string, TaskLabels>> {
  const refs = collect(rows);
  const [packRows, cardRows, pixelRows] = await Promise.all([
    refs.packSlugs.size
      ? packs.listPacks(
          { slug: [...refs.packSlugs] },
          { select: ['slug', 'title'], take: refs.packSlugs.size },
        )
      : Promise.resolve([]),
    refs.cardHandles.size
      ? packs.listCards(
          { handle: [...refs.cardHandles] },
          {
            select: ['handle', 'name', 'grader', 'grade'],
            take: refs.cardHandles.size,
          },
        )
      : Promise.resolve([]),
    // `listPixelPokemon`, SINGULAR — Medusa treats "pokemon" as uncountable, so
    // the runtime method does not match the naively-pluralized generated type.
    // asPixelPokemonCrud bridges that; calling packs.listPixelPokemons here
    // type-checks and then throws "is not a function" at runtime.
    refs.pixelIds.size
      ? asPixelPokemonCrud(packs).listPixelPokemon(
          { id: [...refs.pixelIds] },
          { select: ['id', 'name', 'dex'], take: refs.pixelIds.size },
        )
      : Promise.resolve([]),
  ]);

  const packTitle = new Map(packRows.map((p) => [p.slug, p.title]));
  const cardName = new Map(
    cardRows.map((c) => [
      c.handle,
      c.grade ? `${c.name} · ${c.grader} ${c.grade}` : c.name,
    ]),
  );
  const pixelName = new Map(
    pixelRows.map((p) => [p.id, p.dex ? `#${p.dex} ${p.name}` : p.name]),
  );

  const out = new Map<string, TaskLabels>();
  for (const row of rows) {
    out.set(row.id, {
      requirement: requirementLabel(
        row.requirement,
        row.kind as TaskKind | undefined,
        packTitle,
        pixelName,
      ),
      // A tickets reward IS its tickets: no ' + N tickets' on top of itself.
      reward:
        (row.reward as { type?: unknown } | null)?.type === 'tickets'
          ? ticketsLabel(row.tickets ?? 0)
          : rewardLabel(row.reward, packTitle, cardName) +
            ticketsSuffix(row.tickets),
    });
  }
  return out;
}

/** The amount the goal's own type uses. Rows saved before 2026-11-02 can still
 *  hold a key from an older goal, so never `days ?? count`. */
export function requirementAmount(r: Record<string, unknown>): number {
  const field =
    r.type === 'checkin_days'
      ? r.days
      : r.type === 'reach_level'
        ? r.level
        : r.type === 'topup_myr'
          ? r.amount_myr
          : r.count;
  return Number(field ?? 0);
}

function requirementLabel(
  raw: unknown,
  kind: TaskKind | undefined,
  packTitle: Map<string, string>,
  pixelName: Map<string, string>,
): string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = requirementAmount(r);
  // Daily/weekly goals count one period's activity; an achievement counts a
  // lifetime. Without a kind, check-ins and rips were weekly-only.
  const when =
    kind === 'daily'
      ? 'today'
      : kind === 'weekly' ||
          (!kind && (r.type === 'checkin_days' || r.type === 'rip_count'))
        ? 'this week'
        : null;
  switch (r.type) {
    case 'checkin_days':
      return when === 'today'
        ? 'Check in today'
        : `Check in on ${plural(n, 'day', 'days')} this week`;
    case 'rip_count':
      return typeof r.pack_id === 'string' && r.pack_id
        ? `Rip ${n} × ${name(packTitle, r.pack_id)} ${when}`
        : `Rip ${plural(n, 'pack', 'packs')} ${when}`;
    case 'reach_level':
      return `Reach VIP level ${n}`;
    case 'vault_count':
      return `Vault ${plural(n, 'card', 'cards')}`;
    case 'vault_pixel_count': {
      // A period goal counts paid PULLS in that period; an achievement, the
      // cards ever vaulted.
      const what =
        typeof r.pixel_pokemon_id === 'string' && r.pixel_pokemon_id
          ? `${n} × ${name(pixelName, r.pixel_pokemon_id)}`
          : `${n} Pokémon (pixel) ${n === 1 ? 'card' : 'cards'}`;
      return when ? `Pull ${what} ${when}` : `Vault ${what}`;
    }
    case 'topup_myr':
      // Whole ringgit by validation, so no ".00" on a poster.
      return `Top up RM ${n.toLocaleString('en-MY')} ${when ?? 'in total'}`;
    default:
      // A requirement type this build does not know cannot be evaluated
      // either — taskProgress fails it closed — so say so rather than
      // rendering an empty cell.
      return `Unknown requirement '${String(r.type)}'`;
  }
}

/** The names, pictures and prices the console's board and name check need. */
export interface TaskView {
  /** The Pokémon or pack the goal names; null = any, or no target to name. */
  goal_name: string | null;
  goal_image: string | null;
  /** The least one rip of this goal can cost: its pack's price, or for "any
   *  pack" the cheapest pack on sale. null when the goal isn't a rip. */
  goal_price_myr: number | null;
  /** false = a pack players can't open right now, so the goal can't be finished.
   *  null when the goal names no pack. */
  goal_buyable: boolean | null;
  reward_name: string | null;
  reward_grade: string | null;
  reward_image: string | null;
  /** null for tickets, which have no RM value. */
  reward_value_myr: number | null;
}

export async function resolveTaskViews(
  packs: PacksModuleService,
  rows: { id: string; requirement: unknown; reward: unknown }[],
): Promise<Map<string, TaskView>> {
  const refs = collect(rows);
  const anyPackGoal = rows.some((row) => {
    const r = row.requirement as { type?: unknown; pack_id?: unknown };
    return r?.type === 'rip_count' && !r.pack_id;
  });
  const [packRows, cardRows, pixelRows, onSale] = await Promise.all([
    refs.packSlugs.size
      ? packs.listPacks(
          { slug: [...refs.packSlugs] },
          {
            select: ['slug', 'title', 'price', 'image', 'status', 'in_stock', 'category'],
            take: refs.packSlugs.size,
          },
        )
      : Promise.resolve([]),
    refs.cardHandles.size
      ? packs.listCards(
          { handle: [...refs.cardHandles] },
          {
            select: [
              'handle',
              'name',
              'grader',
              'grade',
              'market_value',
              'market_multiplier',
              'image',
              'slab_image',
            ],
            take: refs.cardHandles.size,
          },
        )
      : Promise.resolve([]),
    refs.pixelIds.size
      ? asPixelPokemonCrud(packs).listPixelPokemon(
          { id: [...refs.pixelIds] },
          {
            select: ['id', 'name', 'image_url', 'variant'],
            take: refs.pixelIds.size,
          },
        )
      : Promise.resolve([]),
    // A capsule spin counts as a rip too, so "any pack" is as cheap as the
    // cheapest pack a player can really open. Free packs don't count (source !=
    // pack), and neither does anything sold out or held for rewards.
    anyPackGoal
      ? packs.listPacks(
          {
            status: 'active',
            in_stock: true,
            category: { $nin: [REWARD_BOX_CATEGORY, FREE_WELCOME_CATEGORY] },
          },
          { select: ['price'], take: 500 },
        )
      : Promise.resolve([]),
  ]);
  const fxRate = cardRows.length ? await resolveFxRate(packs) : 0;
  const packBySlug = new Map(packRows.map((p) => [p.slug, p]));
  const cardByHandle = new Map(cardRows.map((c) => [c.handle, c]));
  const pixelById = new Map(pixelRows.map((p) => [p.id, p]));
  const prices = onSale.map((p) => Number(p.price)).filter((p) => p > 0);
  const cheapest = prices.length ? Math.min(...prices) : null;

  const out = new Map<string, TaskView>();
  for (const row of rows) {
    const q = (row.requirement ?? {}) as Record<string, unknown>;
    const w = (row.reward ?? {}) as Record<string, unknown>;
    const goalPack =
      q.type === 'rip_count' && typeof q.pack_id === 'string'
        ? packBySlug.get(q.pack_id)
        : undefined;
    const goalPixel =
      q.type === 'vault_pixel_count' && typeof q.pixel_pokemon_id === 'string'
        ? pixelById.get(q.pixel_pokemon_id)
        : undefined;
    const rewardPack =
      w.type === 'pack' ? packBySlug.get(String(w.pack_id ?? '')) : undefined;
    const rewardCard =
      w.type === 'card'
        ? cardByHandle.get(String(w.card_handle ?? ''))
        : undefined;
    out.set(row.id, {
      goal_name:
        goalPack?.title ??
        (goalPixel
          ? goalPixel.variant && goalPixel.variant !== 'normal'
            ? `${goalPixel.name} (${goalPixel.variant})`
            : goalPixel.name
          : null),
      goal_image: goalPack?.image || goalPixel?.image_url || null,
      goal_price_myr:
        q.type !== 'rip_count'
          ? null
          : goalPack
            ? Number(goalPack.price)
            : q.pack_id
              ? null
              : cheapest,
      goal_buyable: goalPack
        ? goalPack.status === 'active' &&
          goalPack.in_stock !== false &&
          Number(goalPack.price) > 0 &&
          goalPack.category !== FREE_WELCOME_CATEGORY &&
          goalPack.category !== REWARD_BOX_CATEGORY
        : null,
      reward_name: rewardPack?.title ?? rewardCard?.name ?? null,
      reward_grade:
        rewardCard?.grader && rewardCard.grade
          ? `${rewardCard.grader} ${rewardCard.grade}`
          : null,
      reward_image:
        rewardPack?.image ||
        rewardCard?.slab_image ||
        rewardCard?.image ||
        null,
      reward_value_myr:
        w.type === 'credit'
          ? Number(w.amount_myr ?? 0)
          : rewardPack
            ? Number(rewardPack.price)
            : rewardCard
              ? cardValueMyr(rewardCard, fxRate)
              : null,
    });
  }
  return out;
}

function rewardLabel(
  raw: unknown,
  packTitle: Map<string, string>,
  cardName: Map<string, string>,
): string {
  const r = (raw ?? {}) as Record<string, unknown>;
  switch (r.type) {
    case 'credit':
      return `${rm(Number(r.amount_myr ?? 0))} bonus credit`;
    case 'pack':
      return `Free rip · ${name(packTitle, String(r.pack_id ?? ''))}`;
    case 'card':
      return `Card · ${name(cardName, String(r.card_handle ?? ''))}`;
    default:
      return `Unknown reward '${String(r.type)}'`;
  }
}
