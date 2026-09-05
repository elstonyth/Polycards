import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { globepayEnabled } from '../modules/packs/globepay-deposit';
import {
  getDepositDetail,
  getWithdrawalDetail,
  resolveActiveGateway,
  rowGatewayConfigs,
} from '../modules/packs/gateway';
import { classifyRequeryError } from '../modules/packs/globepay-reconcile';
import {
  GATEWAY_AUDIT_BATCH,
  GATEWAY_AUDIT_REPEAT_MS,
  GATEWAY_AUDIT_WINDOW_MS,
  depositAuditNote,
  withdrawalAuditNote,
  type GatewayAnswer,
} from '../modules/packs/gateway-audit';
import { toOptionalMoney } from '../modules/packs/money';

/**
 * Gateway audit sweep (plan 130). Re-reads FINAL deposit and withdrawal rows
 * against the gateway — the source of truth for money in and out — and
 * records the verdict on the row. Never moves money; the reconcile sweeps own
 * that. Also backfills `net_amount` where the gateway reports a net we never
 * received (TGPay's callback carries no fee; its query does).
 *
 * An ambiguous gateway error (timeout, 5xx, unattributable 400) leaves the
 * row un-stamped so the next run retries it; only a definite answer (a
 * detail, or an explicit not-found) is recorded.
 */
export default async function gatewayAuditJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  await resolveActiveGateway(container);
  if (!globepayEnabled()) return;

  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const configFor = rowGatewayConfigs();
  const now = new Date();
  const since = new Date(now.getTime() - GATEWAY_AUDIT_WINDOW_MS);
  const repeatBefore = new Date(now.getTime() - GATEWAY_AUDIT_REPEAT_MS);
  const due = {
    created_at: { $gte: since },
    $or: [{ audited_at: null }, { audited_at: { $lt: repeatBefore } }],
  };
  const options = {
    take: GATEWAY_AUDIT_BATCH,
    order: { created_at: 'ASC' as const },
  };

  let checked = 0;
  let findings = 0;
  let skipped = 0;

  const deposits = await packs.listGlobePayDeposits(
    { status: ['settled', 'failed', 'expired'], ...due },
    options,
  );
  for (const row of deposits) {
    let answer: GatewayAnswer;
    let netAmount: number | null = null;
    const config = configFor(row.gateway);
    if (!config) {
      skipped += 1;
      continue;
    }
    try {
      const d = await getDepositDetail(row.merchant_transaction_id, config);
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
    await packs.updateGlobePayDeposits({
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

  const withdrawals = await packs.listGlobePayWithdrawals(
    { status: ['settled', 'failed'], ...due },
    options,
  );
  for (const row of withdrawals) {
    let answer: GatewayAnswer;
    const config = configFor(row.gateway);
    if (!config) {
      skipped += 1;
      continue;
    }
    try {
      const d = await getWithdrawalDetail(row.merchant_transaction_id, config);
      answer = { kind: 'detail', state: d.state, amount: Number(d.amount) };
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
    await packs.updateGlobePayWithdrawals({
      id: row.id,
      audited_at: now,
      audit_note: note,
    });
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
