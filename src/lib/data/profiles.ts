/**
 * Public-profile data seam (Task B).
 *
 * `GET /store/profiles/:handle` is the custom PUBLIC backend route (safe
 * subset only — display name, avatar seed, join date, pull stats, recent
 * pulls; never PII). `GET /store/profiles/me` returns — and lazily assigns —
 * the logged-in customer's own handle for the "My Profile" link.
 *
 * Server-only like the other data getters: profile fetches run in server
 * components/actions, sidestepping browser CORS at :4000.
 */
import 'server-only';
import { cache } from 'react';
import { FetchError } from '@medusajs/js-sdk';
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import {
  parseOne,
  PublicProfileSchema,
  ProfileHandleSchema,
} from '@/lib/data/schemas';

export type ProfileRarity =
  | 'Immortal'
  | 'Legendary'
  | 'Mythical'
  | 'Rare'
  | 'Uncommon'
  | 'Common';

export interface PublicProfileCard {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  /** Raw USD FMV — display should prefer marketPriceMyr. */
  market_value: number;
  /** Live MYR display value (FMV × FX × multiplier); absent on older backends. */
  marketPriceMyr?: number;
  image: string;
  slab_image?: string | null;
  /** Gacha tier of the (pack, card) pull — drives the slab's tier frame.
   *  Optional: older backends omit it on collection items (frame is skipped). */
  rarity?: ProfileRarity;
}

export interface PublicProfilePull {
  pack_id: string;
  rarity: ProfileRarity;
  rolled_at: string;
  card: PublicProfileCard;
}

export interface PublicProfile {
  handle: string;
  name: string;
  seed: number;
  avatar_url?: string | null;
  equipped_frame_level?: number | null;
  joined_at: string;
  stats: {
    pulls: number;
    volume: number;
    by_rarity: Record<ProfileRarity, number>;
  };
  collection?: PublicProfileCard[]; // showcased-only; optional: absent = empty (pre-migration compat)
  recent: PublicProfilePull[];
}

/**
 * Result of a public-profile lookup. `notfound` (404 / unknown handle) and
 * `error` (5xx, network, schema-invalid) are distinct on purpose: the page
 * falls back to the deterministic mock pool for `notfound` (a legacy-handle
 * product choice) but must NOT do so for `error` — a backend outage on a real
 * handle would otherwise render a fabricated persona under the real user's name.
 */
export type ProfileResult =
  | { status: 'ok'; profile: PublicProfile }
  | { status: 'notfound' }
  | { status: 'error' };

/**
 * The public profile for a handle. `cache()`-wrapped so `generateMetadata` and
 * the page share one round-trip.
 */
export const getPublicProfile = cache(
  async (handle: string): Promise<ProfileResult> => {
    try {
      const profile = await sdk.client.fetch<PublicProfile>(
        `/store/profiles/${encodeURIComponent(handle)}`,
      );
      const valid = parseOne(PublicProfileSchema, profile);
      if (!valid) {
        logger.error(`[profiles] schema validation failed for "${handle}"`);
        return { status: 'error' };
      }
      return { status: 'ok', profile: valid as unknown as PublicProfile };
    } catch (error) {
      // 404 = not a collector handle (e.g. a mock-pool username) — expected.
      if (error instanceof FetchError && error.status === 404) {
        return { status: 'notfound' };
      }
      logger.error(`[profiles] failed to load profile "${handle}":`, error);
      return { status: 'error' };
    }
  },
);

/** The handle for an explicit token (used right after login, pre-cookie-read). */
export async function fetchProfileHandle(
  token: string,
): Promise<string | null> {
  try {
    const parsed = parseOne(
      ProfileHandleSchema,
      await sdk.client.fetch('/store/profiles/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    return parsed ? parsed.handle : null;
  } catch (error) {
    logger.error('[profiles] failed to load own profile handle:', error);
    return null;
  }
}

/**
 * The logged-in customer's own profile handle (lazily assigned by the backend
 * on first call), or null when logged out or the backend is unreachable.
 */
export async function getOwnProfileHandle(): Promise<string | null> {
  const token = await getAuthToken();
  if (!token) return null;
  return fetchProfileHandle(token);
}
