import { z } from './zod';
import { isRarity } from '@/lib/packs-format';
import type { Rarity } from '@/lib/packs-data';

/** Matches the getters' `Number.isFinite(x)` checks exactly (rejects NaN/±∞). */
export const finite = z.number().refine((n) => Number.isFinite(n));
/** A finite count that is never negative. */
export const count = finite.refine((n) => n >= 0);
/** A string that is one of the known gacha rarities (the old `isRarity` guard),
 *  typed as the tier it proves so no caller has to cast the parse output. */
export const rarity = z.custom<Rarity>(
  (v) => typeof v === 'string' && isRarity(v),
);

/** Drop invalid items — mirrors `(Array.isArray(x)?x:[]).filter(predicate)`. */
export function parseList<T>(schema: z.ZodType<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const result = schema.safeParse(item);
    if (result.success) out.push(result.data);
  }
  return out;
}

/** Null on failure — mirrors a single-object `if (!valid) return null`. */
export function parseOne<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

/** An array field that DROPS invalid items instead of failing the whole parse —
 *  the nested-object analog of `parseList` (one bad row never blanks the
 *  survivors). Use inside a `parseOne` object so a single malformed row degrades
 *  the row, not the whole response.
 *  ponytail: assumes items are never legitimately `null` (true for every object
 *  item here); a schema that allows null would lose those genuine nulls too. */
export function droppableArray<T>(item: z.ZodType<T>) {
  return z
    .array(item.nullable().catch(null))
    .transform((arr) => arr.filter((v): v is T => v !== null));
}

/** Record equivalent of `droppableArray` — drops invalid VALUES, keeps the rest. */
export function droppableRecord<T>(item: z.ZodType<T>) {
  return z
    .record(z.string(), item.nullable().catch(null))
    .transform(
      (rec) =>
        Object.fromEntries(
          Object.entries(rec).filter(([, v]) => v !== null),
        ) as Record<string, T>,
    );
}

/** `parseList` as a schema, for a `Store` port call that validates the whole
 *  response in one place: a malformed item DROPS (one bad row never blanks the
 *  survivors) and a non-array reads as empty. */
export function listOf<T>(item: z.ZodType<T>) {
  return droppableArray(item).catch([]);
}

/**
 * NO envelope validation — every 2xx body passes, whatever it is.
 *
 * The `Store` port takes a schema per call, and two kinds of call must not have
 * one:
 *
 * - the response is IGNORED, a 2xx IS the answer (the avatar-frame POST, the
 *   close-instant ping);
 * - the response must not be REJECTED at the envelope because the customer has
 *   already been CHARGED (`openPack`/`openBatch`/the free-rip spend). A drifted
 *   field would classify as `invalid_shape`, and that action's copy for a
 *   generic failure says "try again" — the one sentence a committed open must
 *   never show. Those read the body through their own
 *   `parseOne(WonCardSchema, …)` instead, where a bad card gets its own "the
 *   card is in your Vault" answer.
 *
 * Callers that read fields off the body cast at the seam, the way
 * `vault.data.items as BackendVaultItem[]` does in actions/vault.ts.
 */
export const UncheckedSchema = z.unknown();
