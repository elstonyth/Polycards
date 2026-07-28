// modules/packs/ledger.ts
//
// Transaction ledger pure logic (POLYCARD-BACK §5): the display-id serial
// successor and the MYT scope derivation. No Medusa/DB imports — unit
// testable standalone, and this is the ONLY place that resolves the spec's
// own case inconsistency between its two examples (display id "TP26Q3A0001"
// is uppercase; ledger_sequence.last_serial "a0413" is lowercase): serials
// are STORED lowercase, RENDERED uppercase in the display id.
//
// ymqInMyt uses a fixed +8h offset, not a timezone library. This is correct
// ONLY because Asia/Kuala_Lumpur has never observed DST (a fixed UTC+8 all
// year) — ponytail: if this ever needs to serve a DST-observing zone, this
// function needs Intl.DateTimeFormat/date-fns-tz instead of the fixed shift.

export type LedgerType = 'TP' | 'SP' | 'SE' | 'OD' | 'RF' | 'AD' | 'WP';

export type LedgerPayload =
  | { type: 'TP'; payment_method: string; gateway_ref: string | null }
  | { type: 'SP'; channel: 'single' | 'batch'; pack_id: string; prize_skus: string[] }
  | { type: 'SE'; card_handle: string; sp_ref_id: string | null; price: number; rate: number }
  | { type: 'OD'; handles: { card_handle: string; qty: number }[]; status: string }
  | { type: 'RF'; period: string; spend_total: number; pct: number }
  | { type: 'AD'; admin_id: string; reason: string; detail: string | null; card_handle: string | null }
  | { type: 'WP'; period: string; stage: number; rank: number; sku: string | null; value: number };

const SERIAL_RE = /^([a-z]+)(\d{4})$/;

// a0001 -> a0002 -> ... -> a9999 -> b0001 -> ... -> z9999 -> aa0001 -> ...
// Digits always reset to 0001 when the letter block advances (spec §5.2).
export function nextSerial(prev: string | null): string {
  if (prev === null) return 'a0001';
  const m = SERIAL_RE.exec(prev);
  if (!m) {
    throw new Error(`ledger: malformed stored serial '${prev}' (expected /^[a-z]+\\d{4}$/)`);
  }
  const [, letters, digits] = m;
  const n = Number(digits);
  if (n < 9999) return `${letters}${String(n + 1).padStart(4, '0')}`;
  return `${nextLetterBlock(letters)}0001`;
}

// Base-26 increment over a..z with carry: a -> b, z -> aa, az -> ba, zz -> aaa.
function nextLetterBlock(letters: string): string {
  const chars = letters.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== 'z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = 'a';
  }
  return `a${chars.join('')}`; // every position carried past 'z'
}

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

export function ymqInMyt(d: Date): { yy: string; q: 1 | 2 | 3 | 4 } {
  const myt = new Date(d.getTime() + MYT_OFFSET_MS);
  const yy = String(myt.getUTCFullYear() % 100).padStart(2, '0');
  const q = (Math.floor(myt.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  return { yy, q };
}

// The ledger_sequence row key: one counter per (type, MYT year, MYT quarter).
export function sequenceScope(type: LedgerType, occurredAt: Date): string {
  const { yy, q } = ymqInMyt(occurredAt);
  return `${type}-${yy}-Q${q}`;
}

// The public display id: TYPE + YY + Q# + UPPERCASE serial.
export function displayId(type: LedgerType, occurredAt: Date, serial: string): string {
  const { yy, q } = ymqInMyt(occurredAt);
  return `${type}${yy}Q${q}${serial.toUpperCase()}`;
}

// Tallies a flat list of card handles (e.g. every pull a delivery order
// covers) into the OD payload's `handles` shape — one { card_handle, qty }
// per distinct handle, first-seen order. Task 8: Task 2 shipped this file
// without foreseeing a multi-card payload; every other LedgerPayload variant
// only ever names ONE card.
export const countByHandle = (handles: string[]): { card_handle: string; qty: number }[] => {
  const m = new Map<string, number>();
  for (const h of handles) m.set(h, (m.get(h) ?? 0) + 1);
  return [...m.entries()].map(([card_handle, qty]) => ({ card_handle, qty }));
};
