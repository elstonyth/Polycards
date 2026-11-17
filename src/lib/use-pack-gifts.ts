'use client';

import { useCallback, useEffect, useState } from 'react';
import { getPackGifts } from '@/lib/actions/pack-gifts';
import { giftsHeldFor } from '@/lib/vault-packs';

export type PackGifts = {
  /** Usable gifts for this pack; 0 while pending, failed or logged out. */
  held: number;
  /** Signed in and the read for this customer + pack has not landed yet. */
  pending: boolean;
  /** The read failed (null or thrown); `held` is 0 until a re-read lands. */
  failed: boolean;
  /** An open spent `n` gifts. The caller guards the open's identity. */
  consume: (n: number) => void;
  /** Re-read: a Retry, or a press whose gifts may be spent or gone. */
  invalidate: () => void;
};

type Read = { key: string; count: number; failed: boolean };

/**
 * Vault packs (Pack Gifts, spec 2026-10-07 §1) held by `customerId` for
 * `packId`. Read on the client only, after mount: the server loader stays
 * customer-free. Keyed on customer + pack, so a switch of either never shows
 * the other's count. `customerId` null (logged out, or a page that never
 * applies gifts) reads nothing.
 */
export function usePackGifts(
  customerId: string | null,
  packId: string,
): PackGifts {
  const key = customerId ? `${customerId}:${packId}` : null;
  const [read, setRead] = useState<Read | null>(null);
  const current = key !== null && read?.key === key ? read : null;
  const pending = key !== null && current === null;

  useEffect(() => {
    if (!pending || !key) return;
    let live = true;
    // Failed, not "none held": a holder is warned (Retry) before paying full.
    const failed: Read = { key, count: 0, failed: true };
    void getPackGifts()
      .then((g) => {
        // getPackGifts reports a failed call as null rather than throwing.
        if (live) {
          setRead(
            g === null
              ? failed
              : { key, count: giftsHeldFor(g, packId), failed: false },
          );
        }
      })
      .catch(() => {
        if (live) setRead(failed);
      });
    return () => {
      live = false;
    };
  }, [pending, key, packId]);

  const consume = useCallback(
    (n: number) =>
      setRead((r) => (r ? { ...r, count: Math.max(0, r.count - n) } : r)),
    [],
  );
  const invalidate = useCallback(() => setRead(null), []);

  return {
    held: current?.count ?? 0,
    pending,
    failed: current?.failed === true,
    consume,
    invalidate,
  };
}
