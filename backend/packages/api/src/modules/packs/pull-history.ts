import { isChallengePrizePack } from './challenge-prize';
import { isLuckyDrawPrizePack } from './lucky-draw';
import { toMoney } from './money';

// Shared by the customer's pull history (GET /store/pulls/history) and the
// ledger rows that name their card (GET /store/credits): both answer "which
// card was that, and what did it cost me" from the pull table alone.

/** The pack name a customer reads for a pull. Reward pulls ride synthetic pack
 *  ids with no Pack row behind them (`challenge-<week>`, `lucky-draw`,
 *  `task-reward`) — name where they came from instead of printing the raw
 *  id. */
export function pullPackTitle(
  pull: { pack_id: string; source?: string | null },
  title: string | undefined,
): string {
  if (title) return title;
  if (isChallengePrizePack(pull.pack_id)) return 'Weekly Challenge';
  if (isLuckyDrawPrizePack(pull.pack_id)) return 'Lucky Draw';
  if (pull.source === 'reward') return 'Task reward';
  return pull.pack_id;
}

/**
 * RM paid per card, keyed by open_id: the open's one pack_open debit split
 * evenly over the pulls it paid for. A batch open is ONE charge for N pulls
 * (charge-pack-batch.ts: price × paid rows), and gifted rows share the open_id
 * but were charged nothing, so they stay out of the divisor. Only the debit
 * counts — a reversal is a separate positive row. An open with no debit row
 * (pre-Phase-2a pulls carry no open_id at all) is simply absent: unknown,
 * never RM 0.
 */
export function paidPerOpen(
  charges: Array<{ source_transaction_id?: string | null; amount: unknown }>,
  openPulls: Array<{ open_id?: string | null; source?: string | null }>,
): Map<string, number> {
  const paidRows = new Map<string, number>();
  for (const p of openPulls) {
    if (!p.open_id || p.source === 'gift') continue;
    paidRows.set(p.open_id, (paidRows.get(p.open_id) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const c of charges) {
    const amount = toMoney(c.amount);
    const rows = c.source_transaction_id
      ? paidRows.get(c.source_transaction_id)
      : undefined;
    if (!rows || !(amount < 0)) continue;
    out.set(
      c.source_transaction_id as string,
      Math.round((-amount / rows) * 100) / 100,
    );
  }
  return out;
}
