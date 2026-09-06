import type { ContainerLike } from '@medusajs/framework/types';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';

// Facets over PacksModuleService.
//
// The service is one ~10k-line MedusaService with ~129 methods, and every
// caller used to resolve the whole surface. A facet names the methods ONE AREA
// of the codebase actually uses, so a reader of a payment route sees the
// handful of methods that route can touch instead of the module's entire
// vocabulary, and so a
// service-side rename or removal fails `check-types` HERE — `Pick` rejects a
// key that is not a member — instead of silently drifting past a hand-built
// test fake.
//
// Facets are named for the AREA they serve, not for a caller: the deposit
// loop, the withdrawal loop, and the read-only admin reports. Add a member
// when a file in that area calls it; add a facet only when an area adopts it.

/** The deposit half of the gateway loop: record intent, credit on callback. */
export type GatewayDeposits = Pick<
  PacksModuleService,
  | 'createGlobePayDepositCapped'
  | 'listGlobePayDeposits'
  | 'updateGlobePayDeposits'
  | 'topUpCreditsWithLedger'
>;

/** The withdrawal half: hold, claim against the debit, submit, refund. */
export type GatewayWithdrawals = Pick<
  PacksModuleService,
  | 'claimWithdrawalAgainstDebit'
  | 'createGlobePayWithdrawals'
  | 'creditBalance'
  | 'listCreditTransactions'
  | 'listCustomerAccountStates'
  | 'listGlobePayWithdrawals'
  | 'savedBankAccountsFor'
  | 'updateGlobePayWithdrawals'
  | 'walletSummary'
  | 'withdrawCreditsWithLedger'
  | 'withdrawForCashout'
>;

/** The read-only /admin/globepay/* reports. Never moves money. */
export type GatewayReports = Pick<
  PacksModuleService,
  | 'gatewayAuditTotals'
  | 'globepaySettlementRows'
  | 'listAndCountGlobePayDeposits'
  | 'listAndCountGlobePayWithdrawals'
  | 'listCustomerAccountStates'
  | 'listGlobePayDeposits'
  | 'listGlobePayWithdrawals'
>;

/**
 * Resolve the packs service narrowed to one facet.
 *
 * The cast is the whole point: the container hands back the full service and
 * the caller is handed the facet, so nothing outside the facet is reachable
 * from that variable.
 */
export function resolvePacks<F>(scope: ContainerLike): F {
  return scope.resolve<PacksModuleService>(PACKS_MODULE) as unknown as F;
}

/**
 * Key-check a hand-built spec fake against a facet:
 *
 *   const packs = { … } satisfies FakeFacet<GatewayWithdrawals>;
 *
 * Every key must name a real member of the facet, so a stub for a method that
 * was renamed or that this area does not own fails `check-types`. Values stay
 * `unknown` on purpose — spec fakes return trimmed rows and partial shapes,
 * and this checks NAMES, not signatures. Use `satisfies`, never a type
 * annotation, or the literal's inferred `jest.Mock` types are erased and every
 * `.mock.calls` assertion in the spec breaks.
 */
export type FakeFacet<F> = Partial<Record<keyof F, unknown>>;
