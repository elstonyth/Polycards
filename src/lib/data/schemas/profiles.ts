import { z } from './zod';
import { finite } from './shared';

/** GET /store/profiles/:handle — handle string + a stats object present. */
export const PublicProfileSchema = z.looseObject({
  handle: z.string(),
  stats: z.looseObject({}),
  avatar_url: z.string().nullable().optional(),
  equipped_frame_level: finite.nullable().optional(),
});
