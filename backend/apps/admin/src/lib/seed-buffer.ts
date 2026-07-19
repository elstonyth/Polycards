/**
 * Decide whether to (re)seed an editable buffer from a server snapshot during
 * render — the shared rule behind the admin editors (daily boxes, pack odds,
 * reward pools) that seed local edit state from React Query data.
 *
 * The bug this guards against: React Query hands `data` a fresh object identity
 * on every refetch (e.g. `refetchOnWindowFocus`), so a `data !== seeded` guard
 * reseeds — silently wiping unsaved edits — on every background refetch. Seed
 * once instead. Callers force an explicit reseed by resetting `seeded` to
 * `undefined` (e.g. after a save), and may pass `isStale` to reseed when the
 * seeded snapshot no longer matches the current target (e.g. a pack-slug switch
 * on a route component the router reuses across params).
 *
 * Returns a type guard so `data` narrows to non-null inside the caller's block.
 */
export function shouldSeedBuffer<T>(
  data: T | null | undefined,
  seeded: T | undefined,
  isStale: (seeded: T) => boolean = () => false,
): data is T {
  if (data == null) return false;
  if (seeded === undefined) return true;
  return isStale(seeded);
}
