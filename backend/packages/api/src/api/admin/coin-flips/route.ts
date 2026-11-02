import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { publicCoinFlipRound, type CoinFlipRoundRecord } from '../../../modules/packs/coin-flip';
import { parsePaginationParams } from '../../../utils/pagination';
import { parseMytBound } from '../../../modules/packs/ledger';

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { limit, offset } = parsePaginationParams(req.query, { defaultLimit: 25, maxLimit: 100 });
  const status = req.query.status === 'won' || req.query.status === 'lost' ? req.query.status : undefined;
  const customerId = req.query.customer_id || undefined;
  const source = req.query.source || undefined;
  if (source && (typeof source !== 'string' || !['pack', 'bonus', 'gift', 'reward', 'free', 'mixed', 'tickets'].includes(source))) throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid funding source filter.');
  if (req.query.status && !status) throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid outcome filter.');
  if (customerId && (typeof customerId !== 'string' || customerId.length > 128)) throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid customer filter.');
  const from = req.query.from ? parseMytBound(req.query.from, 'from') : undefined;
  const to = req.query.to ? parseMytBound(req.query.to, 'to') : undefined;
  if ((req.query.from && !from) || (req.query.to && !to) || (from && to && from >= to)) throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid date range.');
  const filter = { status: status ? [status] : ['won', 'lost'], ...(customerId ? { customer_id: customerId } : {}),
    ...(source ? { snapshot: { source } } : {}),
    ...((from || to) ? { settled_at: { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) } } : {}) };
  const [rows, count] = await packs.listAndCountCoinFlipRounds(filter, { take: limit, skip: offset, order: { settled_at: 'DESC', id: 'DESC' } });
  const totals = await packs.coinFlipTotals({ status, customerId, source, from, to });
  res.json({ rounds: rows.map(row => {
    const record = row as unknown as CoinFlipRoundRecord;
    return { ...publicCoinFlipRound(record), customer_id: record.customer_id, pull_id: record.pull_id,
      snapshot: record.snapshot, roll: record.roll, config_revision: record.config_revision, credit_transaction_id: record.credit_transaction_id };
  }), count, limit, offset, totals });
}
