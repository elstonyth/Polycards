import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { Modules } from '@medusajs/framework/utils';
import {
  generatedUsername,
  isValidUsername,
  sanitizeUsername,
  storedHandle,
} from '../../utils/profile-handle';
import PacksModuleService from '../../modules/packs/service';
import { PACKS_MODULE } from '../../modules/packs';

export type EnsureProfileHandleInput = {
  customer_id: string; // from the authenticated token — NEVER the request body
};

export type EnsureProfileHandleResult = {
  handle: string;
};

// ensure-profile-handle — the customer's PERMANENT public profile handle
// (/profile/<handle>), assigned on the first call and never changed after it.
// Every storefront login and signup makes that first call (GET
// /store/profiles/me), so the handle is fixed from the name the account was
// registered with — the one typed at signup, else an anonymous
// "Collector####" — before the player can have renamed. A later rename changes
// only the display name; see utils/profile-handle.ts for why the two are kept
// apart.
//
// After Migration20260930120000 every live customer already holds a handle, so
// the common path here writes nothing at all.
export const ensureProfileHandleStep = createStep(
  'ensure-profile-handle',
  async (input: EnsureProfileHandleInput, { container }) => {
    const customers = container.resolve(Modules.CUSTOMER);
    const customer = await customers.retrieveCustomer(input.customer_id);

    const existing = storedHandle(customer);
    if (existing) {
      return new StepResponse<EnsureProfileHandleResult, CompensationInput>(
        { handle: existing },
        null,
      );
    }

    const packs = packsOf(container);
    // First call. The handle is frozen from the display name, so the account
    // needs a usable one first: coerce rather than reject — there is no user to
    // show an error to on this path, and a wholly non-ASCII name (production
    // has at least one) survives coercion as nothing, hence the fallback.
    let name = (customer.first_name ?? '').trim();
    let renamed = false;
    if (!isValidUsername(name)) {
      name = await packs.claimUsername({
        customerId: customer.id,
        desired: sanitizeUsername(name) ?? generatedUsername(customer.id),
      });
      renamed = true;
    }
    const handle = await packs.claimHandle({
      customerId: customer.id,
      desired: name,
    });

    return new StepResponse<EnsureProfileHandleResult, CompensationInput>(
      { handle },
      renamed
        ? { customerId: customer.id, previousName: customer.first_name ?? null }
        : null,
    );
  },
  async (data: CompensationInput | undefined, { container }) => {
    if (!data) return;
    // Restore the display name this step replaced. Straight through the
    // customer module, not claimUsername: a rollback must put back exactly
    // what was there, never a suffixed variant of it. The handle is NOT taken
    // back — it is an identifier, not a preference, and a valid unique one
    // costs nothing to keep.
    const customers = container.resolve(Modules.CUSTOMER);
    await customers.updateCustomers(data.customerId, {
      first_name: data.previousName,
    });
  },
);

type CompensationInput = {
  customerId: string;
  previousName: string | null;
} | null;

// Resolved lazily so the no-write path above never touches the packs module.
function packsOf(container: {
  resolve: <T>(key: string) => T;
}): PacksModuleService {
  return container.resolve<PacksModuleService>(PACKS_MODULE);
}

export default ensureProfileHandleStep;
