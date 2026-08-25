import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  validateDeliveryRequest,
  snapshotAddress,
  isMalaysianAddress,
  MY_ONLY_MESSAGE,
} from '../../modules/packs/delivery';
import { FREE_PULL_LOCKED_MESSAGE } from '../../modules/packs/free-pack';
import { resolveFxRate } from '../../modules/packs/pricing';

export type RequestDeliveryInput = {
  customer_id: string; // from the authenticated token — NEVER the request body
  pull_ids: string[];
  address_id: string;
};

export type RequestDeliveryResult = {
  order_id: string;
  status: 'requested';
  pull_ids: string[];
};

type CompensateData =
  | { orderId: string; itemIds: string[]; pullIds: string[] }
  | undefined;

export const verdictError = (
  v: ReturnType<typeof validateDeliveryRequest>,
): MedusaError => {
  switch (v) {
    case 'empty':
      return new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Select at least one card to deliver.',
      );
    case 'duplicate':
      return new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Duplicate cards in the selection.',
      );
    // Per-status messages (sim P3 #9): a double-submit used to read as if the
    // cards vanished. Ownership is checked before status in the validator, so
    // naming the status leaks nothing about other customers' pulls.
    case 'already_delivering':
      return new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'One or more cards are already in a pending delivery request.',
      );
    case 'already_delivered':
      return new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'One or more cards have already been delivered.',
      );
    case 'bought_back':
      return new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'One or more cards were already sold back.',
      );
    case 'not_vaulted':
      return new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'One or more cards are no longer available to deliver.',
      );
    case 'reward_source':
      return new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Reward prizes are shipped from the rewards page, not the vault.',
      );
    // NOT_ALLOWED is a 400 (same mapping as every case above) carrying the one
    // shared lock copy, so vault, buyback and delivery all refuse in the same
    // words.
    case 'free_locked':
      return new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        FREE_PULL_LOCKED_MESSAGE,
      );
    // not_found AND forbidden both surface as 404 — no cross-account leak.
    default:
      return new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'One or more cards were not found.',
      );
  }
};

export const requestDeliveryStep = createStep(
  'request-delivery',
  async (input: RequestDeliveryInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const customerModule = container.resolve(Modules.CUSTOMER);

    // 1. Validate the selection (ownership + vaulted).
    const pulls = input.pull_ids.length
      ? await packs.listPulls(
          { id: input.pull_ids },
          { take: input.pull_ids.length },
        )
      : [];
    // One indexed read for the whole batch: a free welcome pull can't ship
    // until this customer has opened a PAID pack (spec 2026-08-14).
    const freeUnlocked = await packs.hasPaidOpen(input.customer_id);
    const verdict = validateDeliveryRequest(
      pulls,
      input.pull_ids,
      input.customer_id,
      freeUnlocked,
    );
    if (verdict !== 'ok') throw verdictError(verdict);

    // Frozen accounts cannot draw value out — physical delivery extracts value
    // exactly like buyback, so it gets the same gate (audit 2026-07-07 #2).
    await packs.assertNotFrozen(input.customer_id);

    // 2. Resolve + verify the address belongs to the caller, then snapshot it.
    const [address] = await customerModule.listCustomerAddresses(
      { id: input.address_id, customer_id: input.customer_id },
      { take: 1 },
    );
    if (!address) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'Shipping address not found.',
      );
    }
    const snapshot = snapshotAddress(address);
    if (!snapshot) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'That address is missing required shipping fields.',
      );
    }
    // Only MY rates exist (West RM15 / East RM35 — computeDeliveryFee), so a
    // non-Malaysian address has no priceable shipment. Refuse up front rather
    // than undercharge an international parcel.
    if (!isMalaysianAddress(snapshot.ship_country_code)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, MY_ONLY_MESSAGE);
    }
    // The storefront's inline address form carries no phone field, so most
    // addresses snapshot with ship_phone null and the admin delivery view
    // showed "—" even when the customer's profile had a phone. Fall back to
    // the profile phone (required at registration since 2026-08-01) so the
    // order always carries a reachable number.
    if (!snapshot.ship_phone) {
      const [customer] = await customerModule.listCustomers(
        { id: input.customer_id },
        { take: 1 },
      );
      snapshot.ship_phone = customer?.phone ?? null;
    }

    // 3. Create the order + items + pull flip, plus the paired OD ledger row,
    //    all in ONE atomic transaction (see createDeliveryOrderWithLedger).
    //    A failure partway through rolls back via that method's own
    //    transaction — nothing left to manually unwind here, unlike the old
    //    three-stage try/catch this replaced.
    //
    //    fx resolved HERE, before the transactional call, matching
    //    record-pull.ts's precedent — see createDeliveryOrderWithLedger's
    //    own comment for why resolving it INSIDE that method would risk a
    //    second pool connection while its transaction is open.
    const fx = await resolveFxRate(packs);
    const { orderId, itemIds } = await packs.createDeliveryOrderWithLedger({
      customerId: input.customer_id,
      snapshot,
      pullIds: input.pull_ids,
      fx,
    });

    const result: RequestDeliveryResult = {
      order_id: orderId,
      status: 'requested',
      pull_ids: input.pull_ids,
    };
    return new StepResponse(result, {
      orderId,
      itemIds,
      pullIds: input.pull_ids,
    } satisfies CompensateData);
  },
  // COMPENSATION — reverse everything if a LATER workflow step fails.
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.updatePulls(
      data.pullIds.map((id) => ({ id, status: 'vaulted' as const })),
    );
    await packs.deleteDeliveryOrderItems(data.itemIds);
    await packs.deleteDeliveryOrders([data.orderId]);
    await packs.deleteLedgerEntryByRef('OD', data.orderId);
    // Undo the fee debit (in-flight rollback only, mirroring the ledger-row
    // delete above). The guarded delete needs ids, so resolve the row first —
    // its `reference` is the order id, unique to this request.
    const feeRows = await packs.listCreditTransactions(
      { reason: 'delivery_fee', reference: data.orderId },
      { take: 10 },
    );
    if (feeRows.length) {
      await packs.deleteCreditTransactionsGuarded(feeRows.map((r) => r.id));
    }
  },
);

export default requestDeliveryStep;
