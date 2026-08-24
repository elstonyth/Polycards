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

export type LedgerType = 'TP' | 'SP' | 'SE' | 'OD' | 'AD' | 'WP' | 'WD' | 'RF';

export type LedgerPayload =
  | { type: 'TP'; payment_method: string; gateway_ref: string | null }
  | {
      type: 'SP';
      channel: 'single' | 'batch';
      pack_id: string;
      prize_skus: string[];
    }
  | {
      type: 'SE';
      card_handle: string;
      sp_ref_id: string | null;
      price: number;
      rate: number;
    }
  | {
      type: 'OD';
      handles: { card_handle: string; qty: number }[];
      status: string;
    }
  | {
      type: 'AD';
      admin_id: string;
      reason: string;
      detail: string | null;
      card_handle: string | null;
    }
  | {
      type: 'WP';
      period: string;
      stage: number;
      rank: number;
      sku: string | null;
      value: number;
    }
  // WD: a GlobePay365 payout. One row when the debit is taken (negative
  // wallet_delta) and, if the payout later fails, one when it is refunded
  // (positive) — the pair nets to zero, which is how a bounced withdrawal
  // reads in the ledger. The account number is stored as last-4 ONLY: the
  // full number lives on globepay_withdrawal, and the ledger is an operator-
  // and customer-visible surface.
  | {
      type: 'WD';
      outcome: 'requested' | 'refunded';
      bank_code: string | null;
      account_last4: string | null;
      gateway_ref: string | null;
    }
  // RF: a weekly referral-engine payout (rebuild, spec 2026-08-24) — either a
  // referral commission (tier % of the referrer's downline weekly pack
  // turnover) or a VIP personal rebate (回水, rebate_bp of the member's OWN
  // weekly turnover). ref_id = the weekly_settlement_line id, which makes the
  // (type, ref_id) idempotency index the Wednesday pay step's re-run guard.
  | {
      type: 'RF';
      kind: 'referral_commission' | 'vip_rebate';
      week_start: string;
      basis_cents: number;
      rate_bp: number;
    };

const SERIAL_RE = /^([a-z]+)(\d{4})$/;

// a0001 -> a0002 -> ... -> a9999 -> b0001 -> ... -> z9999 -> aa0001 -> ...
// Digits always reset to 0001 when the letter block advances (spec §5.2).
export function nextSerial(prev: string | null): string {
  if (prev === null) return 'a0001';
  const m = SERIAL_RE.exec(prev);
  if (!m) {
    throw new Error(
      `ledger: malformed stored serial '${prev}' (expected /^[a-z]+\\d{4}$/)`,
    );
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
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Coerce one admin date-range bound (GET /admin/ledger ?from=/?to=) into the
// UTC instant to bind. A date-only 'YYYY-MM-DD' — what `<input type="date">`
// submits — is the OPERATOR'S MYT CALENDAR DAY, the same zone the display-id
// quarter math above uses, so the range is HALF-OPEN: `from` is that day's MYT
// midnight and `to` is the NEXT MYT midnight, EXCLUSIVE (pair it with `<`, not
// `<=`). Both halves matter: without the +1 day, from=X&to=X asked for a
// zero-width window and returned nothing; without the -8h, "today" near
// midnight MYT was off by the UTC+8 gap in both directions.
//
// Anything else (a full ISO instant) is taken literally — a caller that
// already knows the exact instant it wants is not asking for a calendar day.
// Unparseable input returns undefined rather than an Invalid Date (binding one
// to a timestamptz param makes pg throw). This stays a PURE signal — it is the
// route's coerceMytBound that turns it into a 400, so this file keeps its "no
// Medusa imports" property.
export function parseMytBound(
  v: unknown,
  edge: 'from' | 'to',
): Date | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const s = v.trim();
  if (!DATE_ONLY_RE.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  // A date-only ISO string parses as UTC midnight; -8h lands on MYT midnight.
  // Still NaN-guarded — the regex admits '2026-13-01', Date.parse doesn't.
  const utcMidnight = Date.parse(s);
  if (Number.isNaN(utcMidnight)) return undefined;
  return new Date(utcMidnight - MYT_OFFSET_MS + (edge === 'to' ? DAY_MS : 0));
}

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
export function displayId(
  type: LedgerType,
  occurredAt: Date,
  serial: string,
): string {
  const { yy, q } = ymqInMyt(occurredAt);
  return `${type}${yy}Q${q}${serial.toUpperCase()}`;
}

// Tallies a flat list of card handles (e.g. every pull a delivery order
// covers) into the OD payload's `handles` shape — one { card_handle, qty }
// per distinct handle, first-seen order. Task 8: Task 2 shipped this file
// without foreseeing a multi-card payload; every other LedgerPayload variant
// only ever names ONE card.
export const countByHandle = (
  handles: string[],
): { card_handle: string; qty: number }[] => {
  const m = new Map<string, number>();
  for (const h of handles) m.set(h, (m.get(h) ?? 0) + 1);
  return [...m.entries()].map(([card_handle, qty]) => ({ card_handle, qty }));
};
