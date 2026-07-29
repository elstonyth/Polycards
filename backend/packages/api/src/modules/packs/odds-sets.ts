import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService, MedusaContainer } from '@medusajs/framework/types';

export type OddsSet = 1 | 2 | 3;
export type SetWeights = { weight: number; weight_2?: number | null; weight_3?: number | null };

// D2 fallback chain: set 2 empty → set 1; set 3 empty → set 2. Per card.
export const weightForSet = (o: SetWeights, set: OddsSet): number =>
  set === 1
    ? o.weight
    : set === 2
      ? (o.weight_2 ?? o.weight)
      : (o.weight_3 ?? o.weight_2 ?? o.weight);

// Defensive: anything that is not exactly set 2 or 3 rolls to set 1 (the
// default group's set). Group metadata is admin-written but untyped JSON.
export const coerceOddsSet = (v: unknown): OddsSet =>
  v === 2 || v === '2' ? 2 : v === 3 || v === '3' ? 3 : 1;

// Customer → group → odds_set, resolved SERVER-SIDE at spin time (§2.5).
// No group (or anonymous/demo roll) → set 1. A customer in several groups
// gets the OLDEST group's set (created_at ASC — deterministic, documented).
export async function resolveOddsSetForCustomer(
  container: MedusaContainer,
  customerId?: string,
): Promise<OddsSet> {
  if (!customerId) return 1;
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const [group] = await customers.listCustomerGroups(
    { customers: customerId },
    { take: 1, order: { created_at: 'ASC' } },
  );
  return coerceOddsSet(group?.metadata?.odds_set);
}
