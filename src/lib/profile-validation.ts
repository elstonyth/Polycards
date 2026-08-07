/**
 * Shared profile-field validation (client forms + server actions).
 *
 * Phone policy (operator requirement, 2026-08-01): customers register with a
 * phone number picked via a country-code selector, validated by libphonenumber
 * and stored normalized to E.164 (`+60…`) — one canonical shape for the admin
 * delivery view and the SMS integration. The picker offered EVERY country
 * until the SMS destination allowlist landed; it now offers only the served
 * set (see ALLOWED_PHONE_COUNTRIES below). `normalizePhone` itself stays
 * country-agnostic: it also parses numbers already stored on existing rows.
 */
import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';

/** Max length for display/last name — long enough for real names, short
 *  enough that the header/user menu and admin tables never overflow. */
export const NAME_MAX = 30;

/** Default country for the phone picker and for bare local numbers
 *  (`010-766 7787` → +60…). Malaysia is the primary market. */
export const DEFAULT_PHONE_COUNTRY: CountryCode = 'MY';

/**
 * Countries the phone picker offers.
 *
 * PAIRED with the backend SMS allowlist — `ALLOWED_SMS_COUNTRIES` /
 * `DEFAULT_ALLOWED_SMS_COUNTRIES` in
 * `backend/packages/api/src/utils/phone-verification.ts`. Offering a country
 * the backend refuses is the worst failure available here: the user picks it,
 * types a real number, and the verification code silently never arrives. Widen
 * both together, or neither.
 */
export const ALLOWED_PHONE_COUNTRIES: readonly CountryCode[] = ['MY'];

/** Shown when someone TYPES a number outside the served set. Prose, so it
 *  cannot be derived from the list above (Intl has no demonyms) — reword it in
 *  the same change that widens ALLOWED_PHONE_COUNTRIES. */
export const UNSERVED_PHONE_COUNTRY_ERROR =
  'We can only send verification codes to Malaysian (+60) numbers right now.';

/**
 * True iff the backend will actually SMS this E.164 number.
 *
 * The picker only offers served countries, but a typed leading `+` overrides
 * the picked country — `parsePhoneNumberFromString('+442079460958', 'MY')`
 * returns the GB number, valid and all — so a foreign number still reaches
 * submit. Without this the backend refuses it SILENTLY and the user waits for
 * a code that never arrives.
 */
export const isServedPhoneCountry = (phone: string): boolean => {
  const country = parsePhoneNumberFromString(phone)?.country;
  return country !== undefined && ALLOWED_PHONE_COUNTRIES.includes(country);
};

/**
 * Normalize a phone number to E.164. `raw` may be E.164 (`+44 20 7946 0958`),
 * or a national number interpreted against `country` (default MY, so legacy
 * bare `010…` inputs keep working). Returns null when libphonenumber says the
 * number isn't valid for its country.
 */
export function normalizePhone(
  raw: string,
  country: CountryCode = DEFAULT_PHONE_COUNTRY,
): string | null {
  const parsed = parsePhoneNumberFromString(raw, country);
  return parsed?.isValid() ? parsed.number : null;
}
