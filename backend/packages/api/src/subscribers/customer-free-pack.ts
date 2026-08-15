import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';

/**
 * Stamps `free_pack_available_at` on every new registration.
 *
 * This subscriber IS the "new registrations only" rule (spec
 * docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md): accounts that
 * existed before the feature shipped never see this event, so they never carry
 * the stamp — no date cutoff, no backfill script, nothing to keep in sync.
 *
 * The stamp is UNCONDITIONAL, and deliberately so: it encodes only "registered
 * after the feature shipped". Whether the account can actually CLAIM is decided
 * at claim time (an active free pack must exist), so there is nothing here to
 * gate on and no reason to make a registration's stamp depend on catalog state
 * that can change five minutes later.
 *
 * SCOPE, stated plainly because the event cannot tell us where it came from (the
 * payload is an id and nothing else): createCustomersWorkflow also backs POST
 * /admin/customers, so an operator-created customer gets stamped too. That is
 * admin-authenticated and reads as a deliberate grant — the same stance as the
 * phone-verified subscriber's admin-vouch note.
 *
 * Never throws: a missed stamp is fail-safe (that account simply has no free
 * pack, which is the pre-feature status quo), where a rejection would retry-loop
 * the event bus over an account that already exists. Mirrors
 * customer-default-group.ts and customer-phone-verified.ts.
 */
export default async function customerFreePackHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string } | { id: string }[]>) {
  const logger = container.resolve('logger');
  // emitEventStep is handed an ARRAY by createCustomersWorkflow — same shape
  // handling (and same reason) as customer-default-group.ts.
  const ids = (Array.isArray(data) ? data : [data])
    .map((d) => d?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  if (ids.length === 0) return;

  try {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    // markFreePackAvailable is idempotent and first-write-wins, so a replayed
    // event re-stamps nothing and cannot move the timestamp.
    //
    // PER-ID catch: a bulk create is one event for N accounts, and the stamps
    // are independent — one row's failure must not cost the rest of the batch
    // their free pack. The outer catch still covers a failed resolve (nothing
    // to loop over then).
    for (const id of ids) {
      try {
        await packs.markFreePackAvailable(id);
      } catch (e) {
        logger.warn(
          `[customer-free-pack] could not stamp ${id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  } catch (e) {
    logger.warn(
      `[customer-free-pack] could not stamp ${ids.length} customer(s): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export const config: SubscriberConfig = {
  event: 'customer.created',
};
