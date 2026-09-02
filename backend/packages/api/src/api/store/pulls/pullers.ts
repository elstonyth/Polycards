import type { MedusaRequest } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type PacksModuleService from '../../../modules/packs/service';
import { publicProfileFields, seedOf } from '../../../utils/profile-handle';

/** The PII-safe display fields a public pull feed prints for a puller — the
 *  leaderboard's set (utils/profile-handle: first_name, handle, avatar) plus
 *  the equipped milestone frame, resolved to its url. Never email/id. */
export interface PullerProfile {
  who: string;
  /** Seed for the anonymous face; null on an anonymised (hidden) row. */
  seed: number | null;
  profile_handle: string | null;
  avatar_url: string | null;
  frame_url: string | null;
}

export const ANONYMOUS_PULLER: PullerProfile = {
  who: 'Anonymous',
  seed: null,
  profile_handle: null,
  avatar_url: null,
  frame_url: null,
};

/**
 * One lookup for everything the two public pull feeds (recent, gaps) need to
 * name their pullers: the DISABLED set (an administratively disabled or
 * purged player is hidden from every public surface — the caller decides
 * whether that means DROPPING the row, as recent does, or ANONYMISING it, as
 * gaps must because dropping a hit would corrupt its neighbours' gaps), the
 * customer records, and the frame catalog.
 *
 * ponytail: both reads are nullsafe — a harness without the customer module
 * degrades every puller to "Anonymous", and a failed frame-catalog read to
 * frameless rows, rather than 500ing a public route.
 */
export async function loadPullerProfiles(
  req: MedusaRequest,
  packs: PacksModuleService,
  customerIds: readonly (string | null | undefined)[],
): Promise<{
  disabled: Set<string>;
  /** `fallbackKey` (the pull id) seeds the face when there is no customer. */
  profileOf(customerId: string | null, fallbackKey: string): PullerProfile;
}> {
  const ids = [...new Set(customerIds.filter((id): id is string => !!id))];
  const [disabled, frames, customers] = await Promise.all([
    packs.disabledCustomerIds(ids),
    packs
      .siteSettings()
      .then((s) => s.avatar_frames)
      .catch((): Record<string, string> => ({})),
    listCustomersNullsafe(req, ids),
  ]);
  const byId = new Map(customers.map((c) => [c.id, c]));
  return {
    disabled,
    profileOf(customerId, fallbackKey) {
      const customer = customerId ? byId.get(customerId) : undefined;
      // The same seed → face mapping as the leaderboard and the public
      // profile, so one collector wears one face across every surface.
      const seed = seedOf(customerId ?? fallbackKey);
      const profile = publicProfileFields(customer, seed);
      const meta = (customer?.metadata ?? {}) as Record<string, unknown>;
      const level = meta['equipped_frame_level'];
      return {
        // first_name in full (feed policy 2026-08-01); missing → "Anonymous",
        // not the profile's "Collector ####" — that is a profile-page name.
        who: (customer?.first_name ?? '').trim() || 'Anonymous',
        seed,
        profile_handle: profile.handle,
        avatar_url: profile.avatarUrl,
        frame_url:
          typeof level === 'number' ? (frames[String(level)] ?? null) : null,
      };
    },
  };
}

async function listCustomersNullsafe(
  req: MedusaRequest,
  ids: string[],
): Promise<
  {
    id: string;
    first_name: string | null;
    metadata?: Record<string, unknown> | null;
  }[]
> {
  if (ids.length === 0) return [];
  try {
    const customerService = req.scope.resolve(Modules.CUSTOMER);
    return await customerService.listCustomers(
      { id: ids },
      { take: ids.length },
    );
  } catch {
    return [];
  }
}
