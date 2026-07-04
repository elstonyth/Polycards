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
  joined_at: string;
  stats: {
    pulls: number;
    volume: number;
    points: number;
    by_rarity: Record<ProfileRarity, number>;
  };
  collection?: PublicProfileCard[]; // showcased-only; optional: absent = empty (pre-migration compat)
  recent: PublicProfilePull[];
}

/**
 * The public profile for a handle, or null when the handle is unknown (the
 * page then falls back to the mock pool) or the backend is unreachable.
 * `cache()`-wrapped so `generateMetadata` and the page share one round-trip.
 */
export const getPublicProfile = cache(
  async (handle: string): Promise<PublicProfile | null> => {
    try {
      const profile = await sdk.client.fetch<PublicProfile>(
        `/store/profiles/${encodeURIComponent(handle)}`,
      );
      const valid = parseOne(PublicProfileSchema, profile);
      return valid ? (profile as PublicProfile) : null;
    } catch (error) {
      // 404 = not a collector handle (e.g. a mock-pool username) — expected.
      if (error instanceof FetchError && error.status === 404) return null;
      logger.error(`[profiles] failed to load profile "${handle}":`, error);
      return null;
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
