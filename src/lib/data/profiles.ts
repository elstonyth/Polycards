/**
 * Public-profile data seam. The handle in these URLs is the collector's
 * DISPLAY NAME — one value, so a rename moves the profile.
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
import { sdk } from '@/lib/medusa';
import { authedFetch } from '@/lib/authed-fetch';
import { logger } from '@/lib/logger';
import { httpStatus } from '@/lib/errors';
import { getAuthToken } from '@/lib/data/customer';
import {
  parseOne,
  PublicProfileSchema,
  ProfileHandleSchema,
} from '@/lib/data/schemas';

export type ProfileRarity =
  'Immortal' | 'Legendary' | 'Mythical' | 'Rare' | 'Uncommon' | 'Common';

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
   *  Optional: older backends omit it on collection items; null: the odds row
   *  is gone (admin re-keyed it). Both render frameless — never a guessed tier. */
  rarity?: ProfileRarity | null;
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
 * Result of a public-profile lookup. Three failure states, three different
 * pages, and they must stay distinct.
 *
 * `notfound` (404) means nobody holds this display name — a typo, or the old
 * URL of somebody who has since renamed. It is a real 404 page. It used to be
 * answered with a deterministic MOCK persona so every /profile/<x> link kept
 * rendering; that is what got reported as leftover data on 2026-09-04, because
 * /profile/MOONBREON returned an invented collector and so did every other
 * string anyone typed.
 *
 * `error` (5xx, network, schema-invalid) is a real profile we could not load,
 * and says so — retryable, and never conflated with "does not exist".
 *
 * `unavailable` (410) is an administratively DISABLED player. Distinct from
 * `notfound` because a 404 now means the name is FREE: showing one for a
 * disabled account would advertise a name its owner still holds.
 */
export type ProfileResult =
  | { status: 'ok'; profile: PublicProfile }
  | { status: 'notfound' }
  | { status: 'unavailable' }
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
      // 404 = nobody holds this display name (typo, or a retired URL).
      if (httpStatus(error) === 404) {
        return { status: 'notfound' };
      }
      // 410 = a real name the backend is deliberately hiding (disabled
      // account). Not an error, and never a 404 — the name is still taken.
      if (httpStatus(error) === 410) {
        return { status: 'unavailable' };
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
      await authedFetch(token, '/store/profiles/me'),
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
