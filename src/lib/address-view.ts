import type { AddAddressInput, AddressView } from '@/lib/actions/delivery';

/**
 * Build the client-side `AddressView` for an address that was JUST created from
 * a form, so the list can show it without a refetch.
 *
 * Three surfaces did this inline (the address book, the orders edit-address
 * modal, and the vault's delivery request) and each had its own copy of the
 * camelCase mapping — so `AddressView` gaining a field broke all three
 * separately. `addAddress` returns only the new id; everything else is exactly
 * what was typed. Lives outside `actions/delivery.ts` because that file is
 * `'use server'`, where every export must be an async action.
 *
 * `|| null`, matching addressBody in actions/delivery.ts — NOT `?? null`. These
 * are the two halves of one mapping: an optional the operator cleared arrives
 * as `''`, the server stores `null`, and `??` would leave the optimistic row
 * holding `''` until the next reload.
 */
export const addressViewFromInput = (
  id: string,
  input: AddAddressInput,
): AddressView => ({
  id,
  name: `${input.firstName} ${input.lastName}`.trim(),
  firstName: input.firstName,
  lastName: input.lastName,
  line1: input.address1,
  line2: input.address2 || null,
  city: input.city,
  province: input.province || null,
  postalCode: input.postalCode,
  countryCode: input.countryCode,
  phone: input.phone || null,
});
