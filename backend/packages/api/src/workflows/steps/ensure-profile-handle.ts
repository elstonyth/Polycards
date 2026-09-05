import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/framework/utils";
import {
  generatedUsername,
  isValidUsername,
  sanitizeUsername,
} from "../../utils/profile-handle";
import { evictProfileUsername } from "../../utils/profile-cache";
import PacksModuleService from "../../modules/packs/service";
import { PACKS_MODULE } from "../../modules/packs";

export type EnsureProfileHandleInput = {
  customer_id: string; // from the authenticated token — NEVER the request body
};

export type EnsureProfileHandleResult = {
  handle: string;
};

// ensure-profile-handle — the customer's public profile handle, which IS their
// display name (`first_name`): /profile/<display name>. Nothing is derived and
// nothing is stored alongside it, so a rename moves the URL by construction
// rather than by this step remembering to keep two fields in step. That is the
// bug it used to have — see utils/profile-handle.ts.
//
// After Migration20260904120000 every existing customer already holds a valid,
// unique username, so the common path here writes nothing at all. It still
// runs: a row created by a path that bypassed the username guard would
// otherwise have no reachable profile, and this is the only place that notices.
export const ensureProfileHandleStep = createStep(
  "ensure-profile-handle",
  async (input: EnsureProfileHandleInput, { container }) => {
    const customers = container.resolve(Modules.CUSTOMER);
    const customer = await customers.retrieveCustomer(input.customer_id);
    const current = (customer.first_name ?? "").trim();

    if (isValidUsername(current)) {
      // Already usable. Nothing was written; "restoring" the unchanged name
      // keeps both return paths on one compensation shape and is a no-op if
      // the workflow ever rolls back.
      return new StepResponse(
        { handle: current },
        { customerId: customer.id, previousName: customer.first_name ?? null },
      );
    }

    // Not URL-usable. Coerce rather than reject: there is no user to show an
    // error to on this path, and an account with no reachable profile is worse
    // than one whose name lost its spaces. A wholly non-ASCII name (production
    // has at least one) survives coercion as nothing, hence the fallback.
    const desired =
      sanitizeUsername(current) ?? generatedUsername(customer.id);
    const handle = await packsOf(container).claimUsername({
      customerId: customer.id,
      desired,
    });
    // The old spelling had a cache entry only if it was ever a valid username;
    // evicting unconditionally is cheap and keeps the abandoned URL from
    // answering for another 30s.
    evictProfileUsername(current);
    evictProfileUsername(handle);

    const result: EnsureProfileHandleResult = { handle };
    return new StepResponse(result, {
      customerId: customer.id,
      previousName: customer.first_name ?? null,
    });
  },
  async (
    data: { customerId: string; previousName: string | null } | undefined,
    { container },
  ) => {
    if (!data) return;
    // Restore the name this step replaced. Straight through the customer
    // module, not claimUsername: a rollback must put back exactly what was
    // there, never a suffixed variant of it, and the value being restored is
    // one this row already held.
    const customers = container.resolve(Modules.CUSTOMER);
    await customers.updateCustomers(data.customerId, {
      first_name: data.previousName,
    });
    evictProfileUsername(data.previousName);
  },
);

// Resolved lazily so the no-write path above never touches the packs module.
function packsOf(container: {
  resolve: <T>(key: string) => T;
}): PacksModuleService {
  return container.resolve<PacksModuleService>(PACKS_MODULE);
}

export default ensureProfileHandleStep;
