/**
 * Runtime schemas for the custom-backend (`sdk.client.fetch`) responses.
 *
 * The SDK's `fetch<T>` generic is a TYPE ASSERTION, not a runtime guard — a
 * renamed/absent field would otherwise render "$NaN" or an undefined rarity
 * ring. These zod schemas are the guard, centralizing the per-getter validation
 * that used to be hand-rolled `.filter()` predicates.
 *
 * IMPORTANT — behaviour-preserving: each schema validates EXACTLY the fields its
 * getter checked before (no stricter), using `looseObject` so unchecked-but-read
 * fields pass through untouched.
 *
 * A call that goes through the `Store` port hands it ONE schema for the whole
 * response, so the drop-bad-rows semantics live INSIDE the schema: `listOf`
 * (a bad row drops, a non-array reads as empty) or `droppableArray` (a bad row
 * drops, a non-array FAILS — which is what a `cached()` loader needs, so a
 * malformed 200 evicts instead of memoising a blank).
 *
 * The standalone `parseList` / `parseOne` remain for the two things that are
 * not a transport call: nested validation inside an already-parsed body (a won
 * card, a buyback offer), and `src/lib/actions/daily.ts`, which is SUSPENDED
 * and not to be rewritten. `parseList` DROPS invalid items (mirroring the old
 * `.filter()` — one bad row never throws the whole list); `parseOne` returns
 * null on failure. zod's default `.parse()` would THROW — these helpers
 * deliberately do not.
 */
// One file per feature; `./zod` is first so its jitless config loads before
// any schema is built.
export { z, type ZodType } from './zod';
export { parseList, parseOne, UncheckedSchema } from './shared';
export * from './card';
export * from './packs';
export * from './leaderboard';
export * from './challenge';
export * from './profiles';
export * from './avatar-frames';
export * from './announcements';
export * from './vault';
export * from './free-pack';
export * from './pack-open';
export * from './wallet';
export * from './pack-gifts';
export * from './vip';
export * from './notifications';
export * from './daily';
export * from './delivery';
export * from './cards';
export * from './polling';
export * from './lucky-draw';
