import { MedusaError } from '@medusajs/framework/utils';

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

export type PurchaseInvoiceLineBody = {
  card_handle: string;
  card_name: string;
  fmv_snapshot: number;
  qty: number;
  unit_cost: number;
};

export type CreatePurchaseInvoiceBody = {
  date: string;
  supplier: string;
  reverses_invoice_id: string | null;
  lines: PurchaseInvoiceLineBody[];
};

const MAX_LINES = 200;
const MAX_TEXT = 256;
// Sanity ceilings, not business limits: they keep `qty` inside its Postgres
// `integer` column and keep the float product qty * unit_cost orders of
// magnitude inside purchase_invoice_line_line_total_check's half-sen
// tolerance. Without them an absurd body fails as a DB 500 instead of a 400.
const MAX_MONEY = 1_000_000;
const MAX_QTY = 1_000_000;

// An MYR money amount on an invoice line: finite, non-negative, capped, and
// AT MOST 2 DECIMALS.
//
// The 2dp rule is the deliberate part. Money is 2dp everywhere in this system
// (money.ts's toSen/fromSen, economy.ts's integer sen), the same "at most 2
// decimals" gate already guards every other operator-entered ringgit amount
// (credit-adjust.ts's adjustAmountError, topup.ts, voucher-ranges.ts), and
// BOTH admin-UI prefill sources for these fields are already rounded to sen by
// displayMarketPrice. So a sub-sen unit_cost is never a legitimate entry — and
// forbidding it here is what makes the D8 weighted average (inventory-cost.ts)
// and the stored line_total exact rather than merely well-approximated.
//
// Same 1e-6 binary-representation epsilon as the sibling validators
// (credit-adjust.ts, topup.ts, voucher-ranges.ts), and it is load-bearing:
// 0.07 * 100 is 7.000000000000001 and 4.35 * 100 is 434.99999999999994, so an
// exact integer-sen comparison would reject two ordinary prices. NOT 10.1 —
// 10.1 * 100 is exactly 1010. Those three siblings still cite 10.1 (topup.ts
// goes further and states "1009.9999999999999", a value JS never produces);
// their comments are wrong and are outside this change's surface.
//
// The value is normalized back onto the nearest 2dp double on the way out so
// float junk (0.1 + 0.2) never reaches line_total or the reversal match.
const money = (value: unknown, label: string): number => {
  if (typeof value !== 'number' && typeof value !== 'string') {
    bad(`${label} must be a number >= 0.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) bad(`${label} must be a number >= 0.`);
  if (n > MAX_MONEY) bad(`${label} is too large (max ${MAX_MONEY}).`);
  const sen = n * 100;
  if (Math.abs(sen - Math.round(sen)) > 1e-6) {
    bad(`${label} may carry at most 2 decimals.`);
  }
  return Math.round(sen) / 100;
};

// Coerce + validate POST /admin/purchase-invoices. Cross-invoice checks (does
// reverses_invoice_id exist, do lines match the target on
// card_handle+unit_cost, is there anything left to reverse) are NOT here —
// they need a DB read, so the route does them after this pure/sync pass.
export function coerceCreatePurchaseInvoiceBody(
  raw: unknown,
): CreatePurchaseInvoiceBody {
  if (!raw || typeof raw !== 'object') bad('Body must be an object.');
  const b = raw as Record<string, unknown>;

  if (typeof b.date !== 'string' || Number.isNaN(Date.parse(b.date))) {
    bad("'date' must be a valid date string.");
  }
  if (typeof b.supplier !== 'string' || b.supplier.trim() === '') {
    bad("'supplier' is required.");
  }
  const supplier = (b.supplier as string).trim();
  if (supplier.length > MAX_TEXT) {
    bad(`'supplier' is too long (max ${MAX_TEXT} chars).`);
  }

  let reverses_invoice_id: string | null = null;
  if (b.reverses_invoice_id !== undefined && b.reverses_invoice_id !== null) {
    if (
      typeof b.reverses_invoice_id !== 'string' ||
      b.reverses_invoice_id.trim() === ''
    ) {
      bad("'reverses_invoice_id' must be a non-empty string or null.");
    }
    reverses_invoice_id = (b.reverses_invoice_id as string).trim();
  }

  if (!Array.isArray(b.lines) || b.lines.length === 0) {
    bad("'lines' must be a non-empty array.");
  }
  const rawLines = b.lines as unknown[];
  if (rawLines.length > MAX_LINES) {
    bad(`'lines' may have at most ${MAX_LINES} rows.`);
  }

  const lines: PurchaseInvoiceLineBody[] = rawLines.map((rawLine, i) => {
    const l = (rawLine ?? {}) as Record<string, unknown>;
    if (typeof l.card_handle !== 'string' || l.card_handle.trim() === '') {
      bad(`lines[${i}].card_handle is required.`);
    }
    if (typeof l.card_name !== 'string' || l.card_name.trim() === '') {
      bad(`lines[${i}].card_name is required.`);
    }
    const card_handle = (l.card_handle as string).trim();
    const card_name = (l.card_name as string).trim();
    if (card_handle.length > MAX_TEXT || card_name.length > MAX_TEXT) {
      bad(`lines[${i}] card_handle/card_name is too long (max ${MAX_TEXT}).`);
    }
    const fmv_snapshot = money(l.fmv_snapshot, `lines[${i}].fmv_snapshot`);
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty === 0) {
      bad(`lines[${i}].qty must be a non-zero integer.`);
    }
    if (Math.abs(qty) > MAX_QTY) {
      bad(`lines[${i}].qty is too large (max ${MAX_QTY}).`);
    }
    const unit_cost = money(l.unit_cost, `lines[${i}].unit_cost`);
    return { card_handle, card_name, fmv_snapshot, qty, unit_cost };
  });

  // D8 integrity: a reversing invoice may ONLY contain negative-qty lines
  // (the reversal); a normal invoice may NEVER contain a negative-qty line
  // (corrections only happen via reverses_invoice_id). Mismatched sign here
  // is exactly the gap that would silently corrupt the weighted average.
  for (const l of lines) {
    if (reverses_invoice_id !== null && l.qty >= 0) {
      bad(
        'A reversing invoice (reverses_invoice_id set) may only contain negative-qty lines.',
      );
    }
    if (reverses_invoice_id === null && l.qty < 0) {
      bad(
        'A negative-qty line requires reverses_invoice_id — corrections only happen via a reversing invoice.',
      );
    }
  }

  return { date: b.date as string, supplier, reverses_invoice_id, lines };
}

export default coerceCreatePurchaseInvoiceBody;
