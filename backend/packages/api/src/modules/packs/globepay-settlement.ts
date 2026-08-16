// Settlement-report math for /admin/globepay/settlement — the screen that
// answers "what did this week / this month actually do" from OUR database
// instead of GlobePay365's back office (money-path-accuracy-audit-2026-08-17
// B1/B4/B5). Pure merge over three pre-grouped SQL result sets, no container
// and no DB, so the money arithmetic is unit-testable the same way economy.ts
// and credit-summary.ts are. All inputs are integer cents (sen); the report
// converts to 2dp MYR exactly once, at the end.
//
// THE NULL-NET RULE, which every consumer of this report must keep honoring:
// `net_amount` is NULL on any row that settled before the settlement mirror
// shipped (Migration20260817090000) and on any settlement where the gateway
// omitted it. NULL means UNKNOWN, never "no fee". So the fee is computed only
// over rows whose net is known — `grossWithNetCents − netCents` — and the rows
// excluded from it are COUNTED and shown (`missingNet`), rather than silently
// deflating the fee. A period with missingNet > 0 has a fee figure that is a
// floor, not a total, and the response says so structurally.

/** One period-bucket of settled gateway rows, as grouped by the service SQL. */
export type GatewayPeriodRow = {
  /** MYT calendar bucket key, 'YYYY-MM-DD' (first day of the week/month). */
  period: string;
  count: number;
  /** Σ settled gross, cents. Deposits: amount_settled. Withdrawals: amount
   *  (the debit basis — always present, unlike amount_settled on old rows). */
  grossCents: number;
  /** Σ net_amount over rows where it is non-NULL, cents. */
  netCents: number;
  /** Σ gross over the SAME non-NULL-net rows, cents — the fee's other half. */
  grossWithNetCents: number;
  /** Rows in this bucket with net_amount IS NULL ("unknown", pre-mirror). */
  missingNet: number;
};

/** One period-bucket of the credit ledger's gateway-adjacent rows. */
export type LedgerPeriodRow = {
  period: string;
  /** Σ positive `topup` rows, cents — what the ledger says was credited. */
  topupCents: number;
  /** Σ −amount over `cashout` rows, cents — debits net of refunds, i.e. what
   *  the ledger says actually left. */
  cashoutCents: number;
};

export type SettlementDirection = {
  count: number;
  gross: number;
  /** Fee-known subset: Σ net and its matching Σ gross. */
  net: number;
  /** gross − net over the fee-known subset only — a FLOOR when missingNet>0. */
  fee: number;
  /** Settled rows whose net the gateway never told us (NULL, not zero). */
  missingNet: number;
};

export type SettlementPeriod = {
  period: string;
  deposits: SettlementDirection;
  withdrawals: SettlementDirection;
  ledger: {
    /** MYR credited as `topup` in this period per the credit ledger. */
    topupCredited: number;
    /** MYR out as `cashout` (debits net of refunds) per the credit ledger. */
    cashoutNet: number;
  };
  /**
   * Gateway-vs-ledger cross-check (audit B5) — the first place the two
   * independent records of the same money are ever compared.
   *
   *   deposits    = gateway settled gross − ledger topup credited.
   *                 Expected 0: the credit lands in the same request that
   *                 stamps settled_at. Persistently non-zero means a settled
   *                 deposit whose credit never landed (investigate), or a
   *                 mock/manual top-up with no gateway row behind it (which is
   *                 exactly what it should surface — audit C1).
   *   withdrawals = gateway settled gross − ledger cashout net.
   *                 TIMING-SKEWED by design: the debit is written at submit
   *                 and the settle can land in a later bucket (held rows: days
   *                 later), and a refund can land in a later bucket than its
   *                 debit. Read it over adjacent periods, not as a per-bucket
   *                 alarm.
   */
  delta: { deposits: number; withdrawals: number };
};

const EMPTY_DIRECTION: SettlementDirection = {
  count: 0,
  gross: 0,
  net: 0,
  fee: 0,
  missingNet: 0,
};

function toDirection(row: GatewayPeriodRow | undefined): SettlementDirection {
  if (!row) return EMPTY_DIRECTION;
  return {
    count: row.count,
    gross: row.grossCents / 100,
    net: row.netCents / 100,
    // Fee over the known-net subset ONLY — see the NULL-net rule above.
    fee: (row.grossWithNetCents - row.netCents) / 100,
    missingNet: row.missingNet,
  };
}

/**
 * Merge the three grouped result sets into one period-keyed report, newest
 * first. A period present in ANY source appears; absent halves render as
 * zeros (a week with deposits but no payouts is normal, not an error).
 */
export function mergeSettlementPeriods(
  deposits: GatewayPeriodRow[],
  withdrawals: GatewayPeriodRow[],
  ledger: LedgerPeriodRow[],
): SettlementPeriod[] {
  const depositsBy = new Map(deposits.map((r) => [r.period, r]));
  const withdrawalsBy = new Map(withdrawals.map((r) => [r.period, r]));
  const ledgerBy = new Map(ledger.map((r) => [r.period, r]));

  const periods = [
    ...new Set([
      ...depositsBy.keys(),
      ...withdrawalsBy.keys(),
      ...ledgerBy.keys(),
    ]),
  ].sort((a, b) => (a < b ? 1 : -1));

  return periods.map((period) => {
    const d = toDirection(depositsBy.get(period));
    const w = toDirection(withdrawalsBy.get(period));
    const l = ledgerBy.get(period);
    const topupCredited = (l?.topupCents ?? 0) / 100;
    const cashoutNet = (l?.cashoutCents ?? 0) / 100;
    return {
      period,
      deposits: d,
      withdrawals: w,
      ledger: { topupCredited, cashoutNet },
      delta: {
        // One subtraction on the already-rounded 2dp values would reintroduce
        // float drift (49.999999…); do it in cents and divide once, the
        // walletSummary precedent.
        deposits:
          ((depositsBy.get(period)?.grossCents ?? 0) - (l?.topupCents ?? 0)) /
          100,
        withdrawals:
          ((withdrawalsBy.get(period)?.grossCents ?? 0) -
            (l?.cashoutCents ?? 0)) /
          100,
      },
    };
  });
}

/**
 * The report's lower time bound as a UTC instant: the start of the MYT
 * calendar period `periodsBack − 1` steps before the one containing `now`
 * (so `periodsBack` buckets land in view, current one included).
 *
 * Same fixed-+8 arithmetic as ledger.ts ymqInMyt, valid for the same reason
 * (Asia/Kuala_Lumpur has no DST). Weeks are ISO weeks — Monday start —
 * matching Postgres date_trunc('week', …), which the service's GROUP BY uses;
 * two different week conventions here would shear the first bucket in half.
 */
export function settlementSince(
  granularity: 'week' | 'month',
  periodsBack: number,
  now: Date,
): Date {
  const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
  const myt = new Date(now.getTime() + MYT_OFFSET_MS);
  if (granularity === 'month') {
    const start = Date.UTC(
      myt.getUTCFullYear(),
      myt.getUTCMonth() - (periodsBack - 1),
      1,
    );
    return new Date(start - MYT_OFFSET_MS);
  }
  // ISO Monday of the current MYT week, then back (periodsBack − 1) weeks.
  const dow = (myt.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = Date.UTC(
    myt.getUTCFullYear(),
    myt.getUTCMonth(),
    myt.getUTCDate() - dow - (periodsBack - 1) * 7,
  );
  return new Date(monday - MYT_OFFSET_MS);
}
