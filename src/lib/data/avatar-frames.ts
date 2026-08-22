/**
 * Avatar-frame catalog seam — the public milestone-frame map (level → image
 * URL) the storefront overlays on profile photos. Server-only like the other
 * data getters; failures degrade to {} (avatars render frameless).
 */
import 'server-only';
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { parseOne, AvatarFramesSchema } from '@/lib/data/schemas';
import { cached } from '@/lib/ttl-cache';

// A milestone-frame catalog changes when the operator adds a frame — never
// between two page views. React's cache() only deduped this WITHIN one request,
// so /leaderboard (and every profile) paid a fresh backend hop, and a DB read
// behind it, per visitor; unlike the pack and board routes this one has no
// backend-side cache to fall back on. 60s over a catalog that changes monthly.
const FRAMES_TTL_MS = 60_000;

/**
 * The degradation is caught HERE, outside `cached`, and the loader is left to
 * throw. Catching inside would make a transient backend failure resolve to an
 * empty map, which `cached` cannot tell from a real one — so one blip would
 * strip every avatar frame for the full 60s window instead of for the blip.
 * Rejecting lets `cached` evict, and the next request retries.
 */
export async function getAvatarFrames(): Promise<Record<string, string>> {
  try {
    return await cached('avatar-frames', FRAMES_TTL_MS, async () => {
      const parsed = parseOne(
        AvatarFramesSchema,
        await sdk.client.fetch('/store/avatar-frames', { cache: 'no-store' }),
      );
      return parsed ? parsed.frames : {};
    });
  } catch (error) {
    logger.error('[avatar-frames] catalog load failed:', error);
    return {};
  }
}
