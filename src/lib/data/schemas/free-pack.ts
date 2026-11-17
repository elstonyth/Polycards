import { z } from './zod';
import { finite, listOf, parseOne } from './shared';

/** GET /store/free-pack — the one-time welcome-pack claim badge's whole answer.
 *  `image` rides along on the loose object but is unread: the badge art is a
 *  fixed local asset, not the pack shot. Anything unparsable degrades to "not
 *  eligible" in the getter — the badge is an enhancement, never an error
 *  surface. */
export const FreePackSchema = z.looseObject({
  eligible: z.boolean(),
  slug: z.string().nullable(),
  /** Authed answers only (spec 2026-10-06): what the claim would still be
   *  refused for. Optional for deploy skew — absent reads as nothing missing,
   *  and the backend claim step stays the enforcement. */
  missing: z.array(z.enum(['phone', 'real_name', 'bank'])).optional(),
  /** Anonymous answers only: "an active free pack exists" (the signup hook). */
  promo: z.boolean().optional(),
});

/** POST /store/vault/:id/showcase response — pull_id + final showcased state. */
export const VaultShowcaseSchema = z.looseObject({
  pull_id: z.string(),
  showcased: z.boolean(),
});

/** GET /store/credits — finite balance. */
export const BalanceSchema = z.looseObject({ balance: finite });

/** GET /store/vault/latest and GET /store/credits/latest — the newest event on
 *  an unread-dot surface. null when there is nothing; the client renders no dot. */
export const LatestEventSchema = z.looseObject({
  latest_event_at: z.string().nullable(),
});

/** GET /store/credits — lifetime totals (balance is also validated by BalanceSchema).
 *  `has_more` (pagination) is optional so an older backend still parses.
 *  Applied SOFTLY by CreditsPageSchema below, never on its own. */
const CreditsSchema = z.looseObject({
  balance: finite,
  topup_total: finite,
  spend_total: finite,
  // The history's split of spend_total (2026-10-15): all money spent on pack
  // opens (bonus part included), and money withdrawn. Optional so an older
  // backend still parses.
  pack_spend_total: finite.optional(),
  withdrawn_total: finite.optional(),
  has_more: z.boolean().optional(),
});

/** Every reason the backend `credit_transaction` ledger emits (keep in sync with
 *  backend models/credit-transaction.ts) — the known set that gets a proper
 *  label (`REASON_LABEL` in transactions.ts) and a `CreditReason` type for
 *  call sites that only ever produce a known reason. It is NOT a validation
 *  gate: `CreditTransactionSchema.reason` accepts any string (see below), so a
 *  backend reason added before the storefront redeploys still renders — as a
 *  generic prettified row via `reasonLabel`'s fallback — instead of vanishing
 *  from the customer's history (audit 2026-07-07 #11; parseList silently
 *  dropped rows failing the old `z.enum(CREDIT_REASONS)` check). */
export const CREDIT_REASONS = [
  'buyback',
  'topup',
  'pack_open',
  'adjustment',
  'cashout',
  'voucher_claim',
  'reward_credit',
  'daily_reward',
  // Referral rebuild (spec 2026-08-24): the Wednesday settlement payout.
  'referral_commission',
  'delivery_fee',
  // Bonus credit (spec 2026-10-07): an admin grant (+) or take-back (−).
  'bonus_grant',
  'coin_flip_win',
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

/** GET /store/payments/config — the active gateway's money bands. */
export const PaymentConfigSchema = z.looseObject({
  gateway: z.string(),
  deposit: z.looseObject({ min_rm: finite, max_rm: finite }),
  withdrawal: z.looseObject({ min_rm: finite, max_rm: finite }),
  // Absent on a backend older than #557's /store/payments/config; absent
  // reads as open so an older backend keeps today's behaviour.
  deposits_enabled: z.boolean().optional(),
  withdrawals_enabled: z.boolean().optional(),
  // ISO instant a timed withdrawal pause ends (null/absent = no timed pause).
  withdrawals_paused_until: z.string().nullable().optional(),
  // Closed by the admin (switch or daily hours) or a timed pause: the Withdraw
  // button opens an "unavailable" popup. Absent (older backend) = not closed.
  withdrawals_unavailable: z.boolean().optional(),
  // Regional rails beside the active gateway (A3Pay: SGD). Optional — an
  // older backend has none, and a malformed list must not fail the bands.
  regional: z
    .array(
      z.looseObject({
        gateway: z.string(),
        currency: z.string(),
        deposits_enabled: z.boolean(),
        withdrawals_enabled: z.boolean(),
        deposit: z.looseObject({
          min: finite.nullable(),
          max: finite.nullable(),
        }),
        withdrawal: z.looseObject({
          min: finite.nullable(),
          max: finite.nullable(),
        }),
        // The RM a payout through this rail may take today. Optional: a
        // backend older than this field leaves the form on the RM band.
        withdrawal_rm: z
          .looseObject({ min_rm: finite, max_rm: finite })
          .optional()
          .catch(undefined),
        rate: z.looseObject({ deposit: finite, payout: finite }).nullable(),
      }),
    )
    .optional()
    .catch(undefined),
});

/** GET /store/credits transaction row. `amount` is signed (credit +, spend −).
 *  `reason` is any string, not `z.enum(CREDIT_REASONS)` — a backend reason
 *  added before the storefront redeploys must still RENDER (generic label)
 *  — parseList dropping it made history rows silently vanish (audit
 *  2026-07-07 #11; repeat-offender class). */
export const CreditTransactionSchema = z.looseObject({
  id: z.string(),
  amount: finite,
  reason: z.string(),
  created_at: z.string(),
  // Payment-gateway reference (topup/cashout rows; null otherwise). Optional
  // so an older backend that omits the field still parses.
  reference: z.string().nullable().optional(),
  // Gateway channel + our settlement outcome for that reference (topup/cashout
  // rows; null otherwise). Optional for the same older-backend reason.
  gateway: z
    .object({ method: z.string(), status: z.string() })
    .nullable()
    .optional(),
  // Signed bonus-credit part of `amount` (MYR). Optional for the same
  // older-backend reason; absent = no bonus part.
  bonus: finite.optional(),
  // Signed move into (+) or out of (−) "Still to use on packs" (MYR): + a
  // top-up, + a sell-back's free share (bonus, free-pack or prize pulls), −
  // what a pack open used of it. Buyback-only before 2026-10-15. Optional for
  // the same older-backend reason.
  playthrough: finite.optional(),
  // What a pack open bought / a sell-back sold: its pack and card names.
  // Caught, not just optional: a malformed label must never drop a money row.
  pack_title: z.string().nullable().optional().catch(undefined),
  card_names: z.array(z.string()).optional().catch(undefined),
});

/** GET /store/credits as the Transactions page reads it. The totals are SOFT:
 *  a malformed block parses to null and the page shows zeros while still
 *  listing what it can (`totals?.balance ?? 0` in actions/vault.ts); rows drop
 *  one at a time, as every ledger list here does. */
export const CreditsPageSchema = z
  .looseObject({ transactions: listOf(CreditTransactionSchema) })
  .transform((page) => ({
    totals: parseOne(CreditsSchema, page),
    rows: page.transactions,
  }));

/** POST /store/credits/topup response — finite amount + balance. `replayed`
 *  is true when the backend deduped an already-processed Idempotency-Key
 *  (nothing new was charged — sim P2-4); optional so an older backend that
 *  omits the flag still parses. */
export const AmountBalanceSchema = z.looseObject({
  amount: finite,
  balance: finite,
  replayed: z.boolean().optional(),
});

/** GET /store/credits/deposit row — a top-up the customer has started at the
 *  gateway that has not settled yet. `amount` is what we REQUESTED: the settled
 *  figure can differ (a customer may pay another sum), and until it settles
 *  nobody knows it, so the UI must say "confirming", never "credited".
 *  `created_at` drives the elapsed-time line, `merchant_transaction_id` is the
 *  reference support asks for. */
export const PendingDepositSchema = z.looseObject({
  merchant_transaction_id: z.string(),
  amount: finite,
  payment_method_code: z.string().optional(),
  created_at: z.string(),
});

/** GET /store/credits/deposit — the list of those. */
export const PendingDepositsSchema = z.looseObject({
  deposits: listOf(PendingDepositSchema),
});

/** GET /store/credits/deposit/unreported — settled top-ups no browser has
 *  reported to the Meta Pixel yet (lib/pixel.ts reportDeposits). */
export const UnreportedDepositsSchema = z.looseObject({
  deposits: listOf(
    z.looseObject({
      merchant_transaction_id: z.string(),
      amount: finite,
      first: z.boolean().optional(),
    }),
  ),
});

/** POST /store/credits/deposit response — the real payment gateway. Unlike the
 *  mock top-up this credits NOTHING yet: it returns the gateway's cashier URL,
 *  and credit only lands when their signed callback settles the deposit. `url`
 *  is the only field the redirect flow needs; the bank/QR extras ride along on
 *  the loose object for a future in-page renderer. */
/** GET /store/credits/deposit/payer — the paying account's name the
 *  regional top-up sheet shows: a saved account's holder, else nothing saved
 *  and the real name to pre-fill. */
export const DepositPayerSchema = z.looseObject({
  currency: z.string(),
  saved_name: z.string().nullable(),
  real_name: z.string().nullable(),
});

export const DepositStartSchema = z.looseObject({
  // The cashier URL comes from the GATEWAY's response body, which — unlike
  // their callbacks — carries no signature; TLS is the only thing vouching for
  // it, and it flows straight into window.location.assign. A bare z.string()
  // accepts 'javascript:' and 'data:', which CSP script-src does not block for
  // a navigation. Requires a compromised gateway or TLS interception, so this
  // is a trust-boundary belt, not a live hole.
  url: z
    .string()
    .refine((u) => /^https:\/\//i.test(u), 'cashier url must be https'),
  transactionId: z.string(),
  merchantTransactionId: z.string(),
  amount: finite,
});

/** POST /store/credits/withdraw response. The debit already happened —
 *  `balance` is the post-debit balance, and the payout completes (or refunds)
 *  asynchronously via the gateway callback. `transactionId` is null when the
 *  submit outcome was ambiguous (still resolves asynchronously) OR the row was
 *  held for admin approval instead of submitted (see `status`).
 *  `status: 'held'` means the amount left the balance but a human has not yet
 *  approved sending it to the gateway (plan 094) — the form must not render
 *  that as a completed payout.
 *  `.optional()`, not required: this field shipped in plan 094, and the
 *  storefront and backend are separate deploy units (own DO app components) —
 *  a storefront build that rolls out ahead of the backend must still parse a
 *  response with no `status` at all. Absent means a pre-094 backend, which
 *  has no held state, so defaulting to 'pending' downstream (vault.ts) is the
 *  true reading, not a guess. Same reasoning as `usableFrom` on
 *  SavedBankAccountsSchema below: making this required would fail the WHOLE
 *  object during that skew window, and `parseOne` returning null AFTER the
 *  backend already debited is the exact "money vanished" failure this plan
 *  exists to prevent, reached through a different door. */
export const WithdrawStartSchema = z.looseObject({
  merchantTransactionId: z.string(),
  transactionId: z.string().nullable(),
  amount: finite,
  balance: finite,
  status: z.enum(['pending', 'held']).optional(),
  // A regional payout (Singapore): the currency the bank is paid in and the
  // amount it receives. Absent on an RM payout and on an older backend.
  currency: z.string().optional().catch(undefined),
  payAmount: finite.optional().catch(undefined),
});

/** GET /store/credits/withdraw/banks response — the payout bank picker. */
export const WithdrawBanksSchema = z.looseObject({
  banks: z.array(
    z.looseObject({
      bankCode: z.string(),
      bankName: z.string(),
      // The currency that bank is paid in (SGD for Singapore banks via
      // A3Pay). Optional: an older backend sends none, meaning RM.
      currency: z.string().optional(),
      accountLengths: z
        .array(z.number().int().positive())
        .nonempty()
        .optional(),
      accountPattern: z
        .string()
        .refine((pattern) => {
          try {
            new RegExp(pattern);
            return true;
          } catch {
            return false;
          }
        })
        .optional(),
      accountHint: z.string().optional(),
      // A USDT wallet (GlobePay365): the account is an address on this
      // chain. A plain string, not an enum: a chain the backend adds before
      // this build knows it must not fail the whole bank list.
      wallet: z.string().optional(),
    }),
  ),
});

/** /store/credits/withdraw/accounts responses (GET/POST/DELETE all return the
 *  full list) — the customer's saved payout accounts.
 *
 *  `usableFrom` is the server's verdict on the cooling-off window and the only
 *  source of it: an ISO instant the account becomes payable, or null when it
 *  never will without being re-saved. The client renders it and never
 *  recomputes the window, so retuning the backend env moves the UI too.
 *  `.nullish()` because a backend that predates the field omits it entirely —
 *  which lands on the same "not usable" rendering as null, the safe direction. */
export const SavedBankAccountsSchema = z.looseObject({
  accounts: z.array(
    z.looseObject({
      id: z.string(),
      bankCode: z.string(),
      bankName: z.string(),
      accountNumber: z.string(),
      accountHolderName: z.string(),
      usableFrom: z.string().nullish(),
      // The currency the bank is paid in (SGD = a Singapore bank, paid via
      // A3Pay at a converted amount). Optional: absent reads as RM.
      currency: z.string().optional(),
      // Can the active payout provider pay to this bank? Optional so an
      // older backend still parses; absent reads as supported.
      supported: z.boolean().optional(),
      // The bank's own payout floor (RM), e.g. Touch 'n Go 100; null/absent =
      // only the gateway's floor applies.
      minRm: z.number().nullish(),
      // Why an unsupported account cannot be paid right now, when it is not
      // the provider (e.g. the admin paused Touch 'n Go).
      unavailableReason: z.string().nullish(),
      // A USDT wallet's chain; absent for a bank.
      wallet: z.string().optional(),
    }),
  ),
});

/** POST /store/vault/:id/buyback response — finite amount + balance. `percent`
 *  rides along but is NOT rendered on the sell path (consumers read amount/
 *  balance), so it stays OPTIONAL: requiring it would false-fail an idempotent
 *  buyback that succeeded server-side but omitted the field. The rendered
 *  percent is guarded on the vault-list side (VaultItemSchema). */
export const BuybackResultSchema = z.looseObject({
  amount: finite,
  balance: finite,
  percent: finite.optional(),
});

/** POST /store/vault/buyback-batch response. The backend is ours, but a
 *  server action still validates its input at the boundary — and the client
 *  uses `results` to decide what to REMOVE from the vault, so this must never
 *  fail the whole batch over one odd figure: every count is soft (absent or
 *  NaN reads as absent; actions/vault.ts falls back to 0, or to the sold
 *  count for `sold`), a per-pull row drops only when `ok` is not a boolean,
 *  and a malformed `pull_id`/`error` reads as absent rather than dropping the
 *  row that carries the other one. */
const softCount = finite.optional().catch(undefined);
export const BuybackBatchSchema = z.looseObject({
  sold: softCount,
  failed: softCount,
  credited: softCount,
  balance: softCount,
  results: listOf(
    z.looseObject({
      pull_id: z.string().optional().catch(undefined),
      ok: z.boolean(),
      error: z.string().optional().catch(undefined),
    }),
  ),
});
