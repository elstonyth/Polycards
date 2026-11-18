import { z } from './zod';
import { finite } from './shared';
import { WITHDRAW_HOLDS } from '@/lib/wallet-split';

/** GET /store/credits — nested `wallet` block used by getWallet().
 *  The backend returns `{ wallet: { balance, available, is_frozen },
 *  transactions: [...] }`; WalletEnvelopeSchema below reads the block out of
 *  that envelope and validates it with this schema. */
export const WalletSchema = z.looseObject({
  balance: finite,
  available: finite,
  is_frozen: z.boolean(),
  // Playthrough withdrawal gate: withdrawable is 0 until playthrough.remaining
  // hits 0 (lifetime deposits fully spent on pack opens). Both fields are
  // optional (mirroring OddsEntrySchema.marketPriceMyr) so a deploy-skew
  // backend missing them still parses; the consumer applies safe fallbacks.
  // When playthrough is present its inner shape stays strict.
  withdrawable: finite.optional(),
  playthrough: z
    .looseObject({
      deposited: finite,
      used: finite,
      remaining: finite,
    })
    .optional(),
  // Bonus credit inside `balance` (MYR, spend only). Optional: an older
  // backend has none, which reads as 0.
  bonus: finite.optional(),
  // At least one top-up ever: withdrawals and deliveries stay locked until
  // then (2026-10-11). Optional: an older backend has no such gate.
  has_topup: z.boolean().optional(),
  // Why nothing may leave, named by the backend gate (withdrawable.ts
  // withdrawalHold), and what packs must still take before a 'locked' hold
  // opens. Absent from an older backend, and a hold this storefront does not
  // know reads as absent too (.catch), so neither blanks the wallet: getWallet
  // derives the hold instead.
  hold: z.enum(WITHDRAW_HOLDS).nullable().optional().catch(undefined),
  unlock_spend: finite.optional(),
});

/** GET /store/credits as getWallet() reads it — only the `wallet` block. */
export const WalletEnvelopeSchema = z.looseObject({ wallet: WalletSchema });
