import type { MedusaContainer } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { resolveFxRateStrict } from '../../../modules/packs/pricing';
import type { GoodsReceiveNoteLineInput } from '../../../workflows/steps/create-goods-receive-note-records';

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

export type CreateGoodsReceiveNoteBody = {
  date: string;
  supplier: string;
  lines: GoodsReceiveNoteLineInput[];
};

// Same limits as purchase-invoices/validate.ts. A GRN body carries no cost
// and only positive quantities: a correction is an edit (POST /:id, same
// body) or POST /:id/reverse, which builds its own negative lines from the
// GRN it undoes.
const MAX_LINES = 200;
const MAX_TEXT = 256;
const MAX_MONEY = 1_000_000;
const MAX_QTY = 1_000_000;

const fmv = (value: unknown, label: string): number => {
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

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    bad(`${label} is required.`);
  }
  const s = (value as string).trim();
  if (s.length > MAX_TEXT) bad(`${label} is too long (max ${MAX_TEXT} chars).`);
  return s;
};

export function coerceCreateGoodsReceiveNoteBody(
  raw: unknown,
): CreateGoodsReceiveNoteBody {
  if (!raw || typeof raw !== 'object') bad('Body must be an object.');
  const b = raw as Record<string, unknown>;
  if (typeof b.date !== 'string' || Number.isNaN(Date.parse(b.date))) {
    bad("'date' must be a valid date string.");
  }
  const supplier = text(b.supplier, "'supplier'");
  if (!Array.isArray(b.lines) || b.lines.length === 0) {
    bad("'lines' must be a non-empty array.");
  }
  const rawLines = b.lines as unknown[];
  if (rawLines.length > MAX_LINES) {
    bad(`'lines' may have at most ${MAX_LINES} rows.`);
  }
  const lines = rawLines.map((rawLine, i) => {
    const l = (rawLine ?? {}) as Record<string, unknown>;
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      bad(`lines[${i}].qty must be a whole number above 0.`);
    }
    if (qty > MAX_QTY) bad(`lines[${i}].qty is too large (max ${MAX_QTY}).`);
    return {
      card_handle: text(l.card_handle, `lines[${i}].card_handle`),
      card_name: text(l.card_name, `lines[${i}].card_name`),
      fmv_snapshot: fmv(l.fmv_snapshot, `lines[${i}].fmv_snapshot`),
      qty,
    };
  });
  return { date: b.date as string, supplier, lines };
}

// The checks a new GRN and an edit both need before they save.
export async function checkGrnLines(
  scope: MedusaContainer,
  lines: GoodsReceiveNoteLineInput[],
): Promise<void> {
  // Same gate as a purchase invoice: the form's FMV prefill is priced off
  // the FX rate, so refuse while that rate is unknown.
  await resolveFxRateStrict(scope.resolve<PacksModuleService>(PACKS_MODULE));

  // Same existence gate as purchase-invoices/route.ts: every line must name a
  // real product handle.
  const productModule = scope.resolve(Modules.PRODUCT);
  const handles = [...new Set(lines.map((l) => l.card_handle))];
  const products = await productModule.listProducts(
    { handle: handles },
    { take: handles.length, select: ['handle'] },
  );
  const valid = new Set(products.map((p) => p.handle));
  const unknown = lines
    .map((l, i) => ({ i, card_handle: l.card_handle }))
    .filter(({ card_handle }) => !valid.has(card_handle));
  if (unknown.length) {
    bad(
      `Unknown card_handle — no matching product for ${unknown
        .map(({ i, card_handle }) => `lines[${i}] ('${card_handle}')`)
        .join(', ')}.`,
    );
  }
}

export default coerceCreateGoodsReceiveNoteBody;
