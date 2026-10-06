'use server';

/**
 * Vault packs — packs an admin gifted into the customer's vault, unopened.
 *
 * Backend route: GET /store/pack-gifts (customer bearer; the backend derives
 * the customer from the token alone). Read through the `Store` port, which
 * sends it `no-store` — a per-customer read, never cached, and never called
 * from a cached/ISR loader: the pack page reads it client-side after mount.
 */
import { store } from '@/lib/store';
import { PackGiftsSchema } from '@/lib/data/schemas';
import type { PackGift } from '@/lib/vault-packs';

/**
 * The customer's gifted packs, or null when they could not be read (logged
 * out, or a failed call — the port has already logged it). Callers treat null
 * as "none": the open then charges the price the screen showed, never a gift
 * the screen didn't offer.
 */
export async function getPackGifts(): Promise<PackGift[] | null> {
  const r = await store.get('/store/pack-gifts', PackGiftsSchema);
  if (!r.ok) return null;
  return r.data.gifts.map((g) => ({
    packId: g.pack_id,
    count: g.count,
    title: g.title,
    image: g.image ?? null,
    price: g.price,
    available: g.available,
  }));
}
