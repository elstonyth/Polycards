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
  | 'claimDepositStatus'
  | 'createDepositCapped'
  | 'listGatewayDeposits'
  | 'updateGatewayDeposits'
  | 'topUpCreditsWithLedger'
>;

/** The withdrawal half: hold, claim against the debit, submit, refund. */
export type GatewayWithdrawals = Pick<
  PacksModuleService,
  | 'claimWithdrawalStatus'
  | 'claimWithdrawalAgainstDebit'
  | 'createGatewayWithdrawals'
  | 'creditBalance'
  | 'listCreditTransactions'
  | 'listCustomerAccountStates'
  | 'listGatewayWithdrawals'
  | 'savedBankAccountsFor'
  | 'updateGatewayWithdrawals'
  | 'walletSummary'
  | 'withdrawCreditsWithLedger'
  | 'withdrawForCashout'
>;

/** The read-only /admin/payments/* reports. Never moves money. */
export type GatewayReports = Pick<
  PacksModuleService,
  | 'gatewayAuditTotals'
  | 'settlementRows'
  | 'listAndCountGatewayDeposits'
  | 'listAndCountGatewayWithdrawals'
  | 'listCustomerAccountStates'
  | 'listGatewayDeposits'
  | 'listGatewayWithdrawals'
>;

/**
 * The customer-facing wallet surface: `/store/credits`, `/balance`,
 * `/latest`, and the saved-payout-accounts metadata mutator. Ledger reads and
 * a metadata write, not gateway rows — kept separate from `GatewayDeposits`/
 * `GatewayWithdrawals` even though it shares two members with them, because
 * this area never submits to or reconciles against the gateway itself.
 */
export type CustomerWallet = Pick<
  PacksModuleService,
  | 'creditBalance'
  | 'creditSummary'
  | 'listCreditTransactions'
  | 'listGatewayDeposits'
  | 'listGatewayWithdrawals'
  | 'mutateCustomerMetadata'
  | 'walletSummary'
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
