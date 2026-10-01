import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { resolveFxRate } from '../../../../modules/packs/pricing';
import { effectivePlayerGroup } from '../../../../modules/packs/odds-sets';
import { DEPOSIT_STATUSES } from '../../../../modules/packs/models/gateway-deposit';
import { WITHDRAWAL_STATUSES } from '../../../../modules/packs/models/gateway-withdrawal';
import { isValidUsername } from '../../../../utils/profile-handle';
import { and, customerFilter, reportDb, windowFilter } from '../../sql';
import { ledgerTotalsWhere, statusTotals } from '../queries';

const DAY_MS = 24 * 60 * 60 * 1000;

// GET /reports/finance/player?username=: one player's money picture, found
// by their public username. Only id, first_name (the username) and
// created_at are read from the customer, so no contact detail can reach the
// response.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const raw = req.query.username;
  if (!isValidUsername(raw)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'username must be 3-30 letters, digits, _ or -.',
    );
  }
  const username = raw.trim();
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // Staff may have the shown name or the permanent profile handle from a
  // /profile/<handle> link (utils/profile-handle.ts). The two are separate
  // namespaces, so one string can name two players: the shown name wins and
  // the answer says the handle belongs to someone else.
  const byName = await packs.findCustomerIdByUsername(username);
  const byHandle = await packs.findCustomerIdByHandle(username);
  const id = byName ?? byHandle;
  if (!id) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `No player with username or profile handle ${username}.`,
    );
  }
  const clash = !!byName && !!byHandle && byHandle !== byName;
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const customer = await customers.retrieveCustomer(id, {
    select: ['id', 'first_name', 'created_at'],
  });
  const groups = await customers.listCustomerGroups(
    { customers: id },
    { order: { created_at: 'ASC' } },
  );
  const { wallet, vault } = await packs.playersOverview(
    [id],
    await resolveFxRate(packs),
  );
  const db = reportDb(req);
  const mine = customerFilter(id, 'ct.customer_id');
  const now = Date.now();
  const since = new Date(now - 30 * DAY_MS).toISOString();
  const theirs = customerFilter(id, 'g.customer_id');
  res.json({
    currency: 'MYR',
    username: customer.first_name,
    joined_at: customer.created_at,
    group: effectivePlayerGroup(groups)?.name ?? 'DEFAULT',
    disabled: (await packs.disabledCustomerIds([id])).has(id),
    balance: (wallet.get(id)?.balanceCents ?? 0) / 100,
    vault: {
      cards: vault.get(id)?.count ?? 0,
      value: (vault.get(id)?.cents ?? 0) / 100,
    },
    lifetime: await ledgerTotalsWhere(db, mine),
    last_30_days: await ledgerTotalsWhere(
      db,
      and(windowFilter({ from: since }, 'ct.created_at'), mine),
    ),
    last_30_days_window: { from: since, to: new Date(now).toISOString() },
    deposits: await statusTotals(db, 'deposits', DEPOSIT_STATUSES, theirs),
    withdrawals: await statusTotals(
      db,
      'withdrawals',
      WITHDRAWAL_STATUSES,
      theirs,
    ),
    note: 'For one player: revenue = their pack spend, payouts = buybacks paid to them, topups = their deposits credited.',
    ...(clash
      ? {
          lookup_note: `${username} is also the profile handle of a different player. To report on that player, use the name shown on their profile.`,
        }
      : {}),
  });
}
