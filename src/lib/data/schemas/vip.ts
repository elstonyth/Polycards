import { z } from './zod';
import { droppableArray, finite } from './shared';

/** One rung's reward payload, as carried by every `levels` row.
 *
 *  The `next` teaser carries this block on the wire too, and used to declare it
 *  here as well — as a REQUIRED, un-caught field. That gave a malformed teaser
 *  reward the same blast radius #516 had: the whole VipSchema parse fails,
 *  `parseOne` returns null, and `{vipResult.ok && …}` on /me deletes the LV
 *  card. Unlike `levels[]`, which at least feeds the progress bar's floor,
 *  nothing ever read `next.reward` — so it is no longer declared, mapped, or
 *  typed (#523). `looseObject` still lets the field through untouched; it is
 *  simply not validated, and cannot take the card down with it.
 *
 *  `box_tier` left the wire with #490 (Migration20260825120000 dropped the
 *  column); requiring it made EVERY rung fail, so the whole ladder parsed to
 *  [] and /me floored each progress bar at 0. Optional, not removed: only the
 *  SUSPENDED vip-benefits.ts still reads the mapped field. */
const vipReward = z.looseObject({
  voucher_amount: finite,
  box_tier: z.string().optional(),
  frame_unlock: z.boolean(),
});

/** GET /store/vip — VIP level, cumulative spend, and next-rung teaser.
 *  Fields mirror the route's `res.json(...)` shape exactly (snake_case). */
export const VipSchema = z.looseObject({
  level: finite,
  highest_level_ever: finite,
  spend: finite,
  // `reward` is deliberately NOT declared here — see vipReward above. The
  // backend still sends it and looseObject still passes it through; declaring
  // it only gave a field nothing reads the power to blank the LV card (#523).
  next: z
    .looseObject({
      level: finite,
      threshold: finite,
      remaining: finite,
    })
    .nullable(),
  /**
   * A malformed rung drops that rung, not the whole response (#516).
   *
   * The tradeoff a holey ladder normally loses — a customer reading a wrong
   * threshold and thinking they are closer to the next level than they are —
   * barely applies here, because `levels[]` has exactly ONE consumer in the
   * storefront: `me/page.tsx` looks up the CURRENT level's row for `levelStart`,
   * the progress bar's segment floor, and already tolerates a miss with `?? 0`.
   * No ladder list is rendered anywhere. So a dropped rung that is not the
   * customer's own changes literally nothing on screen, and a dropped current
   * rung floors the bar at 0 — reading optimistically full beside the numbers
   * printed directly beneath it, which come from `next` and stay correct.
   *
   * What one bad rung costs today is the entire block: parseOne returns null,
   * getVip returns ok:false, and `{vipResult.ok && …}` deletes the LV card —
   * level number, progress bar and "RM x more to LV y" all gone, for every
   * customer, over a row that customer never sees. Degrading one bar beats
   * deleting the card.
   *
   * `.default([])` carries over unchanged — an omitted ladder still parses to
   * []. A non-array `levels` is a route shape change, not this bug; leave it
   * for whoever hits it.
   */
  levels: droppableArray(
    z.looseObject({
      level: finite,
      threshold: finite,
      reward: vipReward,
    }),
  ).default([]),
});

/** One parsed `levels[]` row — `mapVipLevels`' input (actions/vip-map.ts).
 *  Derived, not re-typed there: the schema is the wire shape's sole
 *  declaration, and zod may only be imported here (the jitless CSP config). */
export type VipLevelRow = z.infer<typeof VipSchema>['levels'][number];
