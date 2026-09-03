import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { MedusaError, Modules } from "@medusajs/framework/utils";
import { HANDLE_RE, deriveHandle } from "../../utils/profile-handle";
import { findCustomerByHandle } from "../../utils/customer-by-metadata";
import PacksModuleService from "../../modules/packs/service";
import { PACKS_MODULE } from "../../modules/packs";

export type EnsureProfileHandleInput = {
  customer_id: string; // from the authenticated token — NEVER the request body
};

export type EnsureProfileHandleResult = {
  handle: string;
};

const MAX_ATTEMPTS = 5;

// ensure-profile-handle — the customer's public profile handle, assigned
// lazily on first request (and by the seed for demo collectors): if
// metadata.handle already exists it is returned untouched; otherwise a
// deterministic candidate (name slug + id hash) is checked for uniqueness and
// persisted into customer metadata.
export const ensureProfileHandleStep = createStep(
  "ensure-profile-handle",
  async (input: EnsureProfileHandleInput, { container }) => {
    const customers = container.resolve(Modules.CUSTOMER);
    const customer = await customers.retrieveCustomer(input.customer_id);

    const metadata = (customer.metadata ?? {}) as Record<string, unknown>;
    const existing = metadata.handle;
    if (typeof existing === "string" && HANDLE_RE.test(existing)) {
      // Already assigned — nothing was written; "restoring" the unchanged
      // metadata keeps both return paths on one compensation shape and is a
      // no-op if the workflow ever rolls back.
      return new StepResponse(
        { handle: existing },
        { customerId: customer.id, previousMetadata: metadata },
      );
    }

    let handle: string | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = deriveHandle(customer.first_name, customer.id, attempt);
      const taken = await findCustomerByHandle(customers, candidate);
      if (!taken || taken.id === customer.id) {
        handle = candidate;
        break;
      }
    }
    if (!handle) {
      // Name-slug + id-hash collisions five deep — practically unreachable.
      throw new MedusaError(
        MedusaError.Types.CONFLICT,
        "Could not assign a unique profile handle",
      );
    }

    // Through the `metadata:<customer>` advisory lock, NOT
    // customers.updateCustomers. `customer.metadata` is one shared JSONB blob
    // (handle / avatar_url / avatar_file_id / equipped_frame_level /
    // bank_accounts) and every writer spread-merges the whole thing, so an
    // unlocked read-then-write here republishes the blob as it looked before a
    // concurrent avatar upload or saved bank account — silently losing it.
    // This step was the last writer left outside the lock plan 092 added.
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.mutateCustomerMetadata({
      customerId: customer.id,
      mutate: (locked) => ({ ...locked, handle }),
    });

    const result: EnsureProfileHandleResult = { handle };
    return new StepResponse(result, {
      customerId: customer.id,
      previousMetadata: metadata,
    });
  },
  async (
    data:
      | { customerId: string; previousMetadata: Record<string, unknown> }
      | undefined,
    { container },
  ) => {
    if (!data) return;
    // Restore ONLY the key this step wrote (handle). Restoring the whole
    // captured snapshot would wipe metadata written concurrently between
    // snapshot and rollback (e.g. equipped_frame_level / avatar_url) — the
    // metadata-wipe class of bug from the 2026-07-07 frames incident.
    // Same lock as the forward path: the rollback is a read-modify-write of the
    // same shared blob, so leaving it on the customer module would clobber
    // concurrent writes exactly where the forward write no longer does.
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.mutateCustomerMetadata({
      customerId: data.customerId,
      mutate: (locked) => ({
        ...locked,
        // Optional-chained: durable-workflow payloads can be deserialized by
        // NEWER code than produced them — a rollback handler never throws on
        // shape drift.
        handle: data.previousMetadata?.handle ?? null,
      }),
    });
  },
);

export default ensureProfileHandleStep;
