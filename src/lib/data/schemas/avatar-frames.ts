import { z } from './zod';

/** GET /store/avatar-frames — public milestone-frame catalog. */
export const AvatarFramesSchema = z.looseObject({
  frames: z.record(z.string(), z.string()),
});
