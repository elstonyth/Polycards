// Store response shapes come from the backend: each route's `types.ts`,
// imported types-only as `@acme/api/store/<route>` (ADR 0017), so a backend
// shape change fails this typecheck. The storefront deploys ahead of the
// backend, so a recently added field may still be absent on the wire:
// `MaybeAbsent` marks those keys optional again, which keeps their `??`
// defaults load-bearing in the type. The zod guards in `@/lib/data/schemas`
// stay the runtime check.
export type MaybeAbsent<T, K extends keyof T> = Omit<T, K> &
  Partial<Pick<T, K>>;
