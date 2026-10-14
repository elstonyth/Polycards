import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { anyGatewayEnabled } from '../modules/packs/gateway-deposit';
import {
  getDepositDetail,
  getWithdrawalDetail,
  resolveActiveGateway,
  rowGatewayConfigs,
} from '../modules/packs/gateway';
import { classifyRequeryError } from '../modules/packs/gateway-reconcile';
import {
  GATEWAY_AUDIT_BATCH,
  GATEWAY_AUDIT_REPEAT_MS,
  GATEWAY_AUDIT_WINDOW_MS,
  depositAuditNote,
  withdrawalAuditNote,
  type GatewayAnswer,
} from '../modules/packs/gateway-audit';
import { toOptionalMoney } from '../modules/packs/money';
import { rowFx } from '../modules/packs/payment-fx';

/**
 * Gateway audit sweep (plan 130). Re-reads FINAL deposit and withdrawal rows
 * against the gateway — the source of truth for money in and out — and
 * records the verdict on the row. Never moves money; the reconcile sweeps own
 * that. BOTH loops also backfill `net_amount` from the query when the row has
 * none (TGPay's callback carries no fee; its query does), and the withdrawal
 * loop additionally REPAIRS a TGPay payout net that disagrees with the
 * gateway — the population written before plan 133, under the old
 * amount − fee convention.
 *
 * An ambiguous gateway error (timeout, 5xx, unattributable 400) leaves the
 * row un-stamped so the next run retries it; only a definite answer (a
 * detail, or an explicit not-found) is recorded.
 */
export default async function gatewayAuditJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  await resolveActiveGateway(container);
  if (!anyGatewayEnabled()) return;

  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const configFor = rowGatewayConfigs();
  const now = new Date();
  const since = new Date(now.getTime() - GATEWAY_AUDIT_WINDOW_MS);
  const repeatBefore = new Date(now.getTime() - GATEWAY_AUDIT_REPEAT_MS);
  // Rows never checked come first, oldest first; the daily re-checks take
  // what is left of the batch, stalest first. One oldest-first query over
  // both let the re-checks use up every batch once the 7-day window held
  // more rows than 24 runs can re-check (2026-10-14: 1,460 rows against
  // 1,200 checks a day), so nothing created after 2026-10-13 13:31 was ever
  // checked: no TGPay fee backfilled, no disagreement seen.
  const fresh = { created_at: { $gte: since }, audited_at: null };
  const stale = {
    created_at: { $gte: since },
    audited_at: { $lt: repeatBefore },
  };
  const first = {
    take: GATEWAY_AUDIT_BATCH,
    order: { created_at: 'ASC' as const },
  };
  const rest = (taken: number) => ({
    take: GATEWAY_AUDIT_BATCH - taken,
    order: { audited_at: 'ASC' as const },
  });

  let checked = 0;
  let findings = 0;
  let skipped = 0;

  const depositStatus = ['settled', 'failed', 'expired'];
  const newDeposits = await packs.listGatewayDeposits(
    { status: depositStatus, ...fresh },
    first,
  );
  const deposits =
    newDeposits.length < GATEWAY_AUDIT_BATCH
      ? [
          ...newDeposits,
          ...(await packs.listGatewayDeposits(
            { status: depositStatus, ...stale },
            rest(newDeposits.length),
          )),
        ]
      : newDeposits;
  for (const row of deposits) {
    let answer: GatewayAnswer;
    let netAmount: number | null = null;
    const config = configFor(row.gateway);
    if (!config) {
      // Money we cannot check is a finding in itself. Stamping it also keeps
      // an orphaned gateway's rows from occupying the batch forever.
      await packs.updateGatewayDeposits({
        id: row.id,
        audited_at: now,
        audit_note: `gateway "${row.gateway}" is not configured here — not audited`,
      });
      findings += 1;
      continue;
    }
    try {
      const d = await getDepositDetail(
        row.merchant_transaction_id,
        config,
        rowFx(row),
      );
      answer = { kind: 'detail', state: d.state, amount: Number(d.amount) };
      netAmount = Number.isFinite(Number(d.netAmount))
        ? Number(d.netAmount)
        : null;
    } catch (error) {
      const refusal = classifyRequeryError(error);
      if (refusal.kind !== 'not-found') {
        skipped += 1;
        logger.warn(
          `[gateway-audit] deposit ${row.merchant_transaction_id}: gateway answer ambiguous (${
            error instanceof Error ? error.message : String(error)
          }) — retry next run`,
        );
        continue;
      }
      answer = { kind: 'not-found' };
    }
    const note = depositAuditNote(
      { status: row.status, amount: toOptionalMoney(row.amount_settled) },
      answer,
    );
    await packs.updateGatewayDeposits({
      id: row.id,
      audited_at: now,
      audit_note: note,
      ...(row.net_amount == null &&
      netAmount !== null &&
      row.status === 'settled'
        ? { net_amount: netAmount }
        : {}),
    });
    checked += 1;
    if (note) {
      findings += 1;
      logger.error(
        `[gateway-audit] deposit ${row.merchant_transaction_id} (${row.status}): ${note}`,
      );
    }
  }

  const withdrawalStatus = ['settled', 'failed'];
  const newWithdrawals = await packs.listGatewayWithdrawals(
    { status: withdrawalStatus, ...fresh },
    first,
  );
  const withdrawals =
    newWithdrawals.length < GATEWAY_AUDIT_BATCH
      ? [
          ...newWithdrawals,
          ...(await packs.listGatewayWithdrawals(
            { status: withdrawalStatus, ...stale },
            rest(newWithdrawals.length),
          )),
        ]
      : newWithdrawals;
  for (const row of withdrawals) {
    let answer: GatewayAnswer;
    let netAmount: number | null = null;
    const config = configFor(row.gateway);
    if (!config) {
      await packs.updateGatewayWithdrawals({
        id: row.id,
        audited_at: now,
        audit_note: `gateway "${row.gateway}" is not configured here — not audited`,
      });
      findings += 1;
      continue;
    }
    try {
      const d = await getWithdrawalDetail(
        row.merchant_transaction_id,
        config,
        rowFx(row),
      );
      answer = { kind: 'detail', state: d.state, amount: Number(d.amount) };
      netAmount = Number.isFinite(Number(d.netAmount))
        ? Number(d.netAmount)
        : null;
    } catch (error) {
      const refusal = classifyRequeryError(error);
      if (refusal.kind !== 'not-found') {
        skipped += 1;
        logger.warn(
          `[gateway-audit] withdrawal ${row.merchant_transaction_id}: gateway answer ambiguous (${
            error instanceof Error ? error.message : String(error)
          }) — retry next run`,
        );
        continue;
      }
      answer = { kind: 'not-found' };
    }
    const note = withdrawalAuditNote(
      { status: row.status, amount: toOptionalMoney(row.amount) },
      answer,
    );
    // Repair (plan 133): rows settled before 2026-09-10 stored net as
    // amount − fee. The gateway's figure is authoritative; overwrite when
    // it disagrees. Deposits never had the inverted convention — do not
    // mirror this there. Scoped to TGPay because the retired gateway's rows
    // were written by a different provider under its own convention and this
    // sweep has no standing to restate them.
    const repairing =
      row.gateway === 'tgpay' &&
      netAmount !== null &&
      row.status === 'settled' &&
      toOptionalMoney(row.net_amount) !== netAmount;
    await packs.updateGatewayWithdrawals({
      id: row.id,
      audited_at: now,
      audit_note: note,
      ...(row.net_amount == null &&
      netAmount !== null &&
      row.status === 'settled'
        ? { net_amount: netAmount }
        : {}),
      ...(repairing ? { net_amount: netAmount } : {}),
    });
    if (repairing && row.net_amount != null) {
      logger.info(
        `[gateway-audit] withdrawal ${row.merchant_transaction_id}: net_amount ${toOptionalMoney(row.net_amount)} -> ${netAmount} (a payout's net is what the wallet PAID, plan 133)`,
      );
    }
    checked += 1;
    if (note) {
      findings += 1;
      logger.error(
        `[gateway-audit] withdrawal ${row.merchant_transaction_id} (${row.status}): ${note}`,
      );
    }
  }

  if (checked > 0 || skipped > 0) {
    logger.info(
      `[gateway-audit] checked=${checked} findings=${findings} skipped=${skipped}`,
    );
  }
}

export const config = {
  name: 'gateway-audit',
  // Hourly: an audit is a second look, not a money mover. Each run touches at
  // most GATEWAY_AUDIT_BATCH rows per kind, one gateway call each.
  schedule: '15 * * * *',
};
