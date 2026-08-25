import type PacksModuleService from '../../../modules/packs/service';
import { asPixelPokemonCrud } from '../../../modules/packs/pixel-pokemon-service';
import type {
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
  rows: { id: string; requirement: unknown; reward: unknown }[],
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
      requirement: requirementLabel(row.requirement, packTitle, pixelName),
      reward: rewardLabel(row.reward, packTitle, cardName),
    });
  }
  return out;
}

function requirementLabel(
  raw: unknown,
  packTitle: Map<string, string>,
  pixelName: Map<string, string>,
): string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = Number(r.days ?? r.count ?? r.level ?? 0);
  switch (r.type) {
    case 'checkin_days':
      return `Check in on ${plural(n, 'day', 'days')} this week`;
    case 'rip_count':
      return typeof r.pack_id === 'string' && r.pack_id
        ? `Rip ${n} × ${name(packTitle, r.pack_id)} this week`
        : `Rip ${plural(n, 'pack', 'packs')} this week`;
    case 'reach_level':
      return `Reach VIP level ${n}`;
    case 'vault_count':
      return `Vault ${plural(n, 'card', 'cards')}`;
    case 'vault_pixel_count':
      return typeof r.pixel_pokemon_id === 'string' && r.pixel_pokemon_id
        ? `Vault ${n} × ${name(pixelName, r.pixel_pokemon_id)}`
        : `Vault ${n} Pokémon (pixel) ${n === 1 ? 'card' : 'cards'}`;
    default:
      // A requirement type this build does not know cannot be evaluated
      // either — taskProgress fails it closed — so say so rather than
      // rendering an empty cell.
      return `Unknown requirement '${String(r.type)}'`;
  }
}

function rewardLabel(
  raw: unknown,
  packTitle: Map<string, string>,
  cardName: Map<string, string>,
): string {
  const r = (raw ?? {}) as Record<string, unknown>;
  switch (r.type) {
    case 'credit':
      return rm(Number(r.amount_myr ?? 0));
    case 'pack':
      return `Free rip · ${name(packTitle, String(r.pack_id ?? ''))}`;
    case 'card':
      return `Card · ${name(cardName, String(r.card_handle ?? ''))}`;
    default:
      return `Unknown reward '${String(r.type)}'`;
  }
}
