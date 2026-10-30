import { INPUT_CLASS } from './ui';

// Malaysia and Singapore are the only countries a delivery goes to
// (isShippableCountry). A fixed list, not free text: the old two-letter box
// collected "60", "+6", "MALAYSIA" and area codes, and 74 Malaysian addresses
// could not ship (2026-10-20). Option text is the country NAME so a browser's
// country autofill ("Malaysia") picks the right option.
const COUNTRIES = [
  { code: 'MY', name: 'Malaysia' },
  { code: 'SG', name: 'Singapore' },
] as const;

/**
 * The address forms' country picker. A saved address with any other code
 * (an old free-text one) shows the placeholder rather than the browser's
 * silent first option, so the customer sees they have to pick one.
 */
export function CountrySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (countryCode: string) => void;
}) {
  const code = value.trim().toUpperCase();
  return (
    <select
      aria-label="Country"
      autoComplete="country"
      required
      value={COUNTRIES.some((c) => c.code === code) ? code : ''}
      onChange={(e) => onChange(e.target.value)}
      className={INPUT_CLASS}
    >
      <option value="" disabled>
        Select country
      </option>
      {COUNTRIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
