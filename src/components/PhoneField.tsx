'use client';

import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';
import { DEFAULT_PHONE_COUNTRY } from '@/lib/profile-validation';

/**
 * Phone input with a country-code picker (operator request 2026-08-01: "select
 * countries with their code"). A native <select> drives the picker — on mobile
 * that opens the OS country list for free — while a styled overlay shows just
 * the flag + dial code. The combined E.164 number rides in a hidden input named
 * `name`, so forms keep reading ONE FormData field exactly as before.
 */

type Country = { iso: CountryCode; dial: string; name: string };

// Regional-indicator flag emoji from the ISO code (no image assets).
const flagOf = (iso: string) =>
  String.fromCodePoint(
    ...[...iso.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );

// Country names from the built-in Intl API — no bundled name table.
const COUNTRIES: Country[] = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  return getCountries()
    .map((iso) => ({
      iso,
      dial: getCountryCallingCode(iso),
      name: names.of(iso) ?? iso,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
})();

export function PhoneField({
  name = 'phone',
  defaultValue = '',
  inputClassName,
  placeholder = 'Phone number',
  required,
  ariaInvalid,
  ariaDescribedby,
  onKeyDown,
}: {
  name?: string;
  /** Stored E.164 value (settings) — seeds both the country and the number. */
  defaultValue?: string;
  /** Class for the visible controls — pass the host form's input class. */
  inputClassName: string;
  placeholder?: string;
  required?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedby?: string;
  /** Scoped to the visible tel input only (not the country <select>) — a
   *  caller that needs an Enter-key shortcut must not also intercept Enter
   *  while the picker is focused. */
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
}) {
  const seeded = defaultValue
    ? parsePhoneNumberFromString(defaultValue)
    : undefined;
  const [country, setCountry] = useState<CountryCode>(
    seeded?.country ?? DEFAULT_PHONE_COUNTRY,
  );
  const [national, setNational] = useState(
    seeded ? seeded.formatNational() : '',
  );

  // Parsing against the picked country strips a local leading 0 (010… → +6010…).
  const e164 = useMemo(() => {
    const digits = national.replace(/\D/g, '');
    if (!digits) return '';
    const parsed = parsePhoneNumberFromString(national, country);
    return parsed?.number ?? `+${getCountryCallingCode(country)}${digits}`;
  }, [national, country]);

  const dial = getCountryCallingCode(country);

  return (
    <div className="flex gap-2">
      {/* Invisible native select over a styled facade: the closed control
          shows only "🇲🇾 +60", the open picker lists every country. */}
      <div className="relative w-28 shrink-0">
        <span
          aria-hidden
          className={`${inputClassName} pointer-events-none flex items-center gap-1 pr-2`}
        >
          <span>{flagOf(country)}</span>
          <span className="truncate">+{dial}</span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-white/50" />
        </span>
        <select
          aria-label="Country code"
          value={country}
          onChange={(e) => setCountry(e.target.value as CountryCode)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        >
          {COUNTRIES.map((c) => (
            <option key={c.iso} value={c.iso}>
              {flagOf(c.iso)} {c.name} (+{c.dial})
            </option>
          ))}
        </select>
      </div>
      <input
        aria-label="Phone number"
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        placeholder={placeholder}
        required={required}
        value={national}
        onChange={(e) => setNational(e.target.value)}
        onKeyDown={onKeyDown}
        aria-invalid={ariaInvalid || undefined}
        aria-describedby={ariaDescribedby}
        className={`${inputClassName} min-w-0 flex-1`}
      />
      <input type="hidden" name={name} value={e164} />
    </div>
  );
}
