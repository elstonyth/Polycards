import type {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { resolveFxRateStrict } from '../../../modules/packs/pricing';
import { createGoodsReceiveNoteWorkflow } from '../../../workflows/create-goods-receive-note';
import {
  parsePaginationParams,
  parseSortParam,
} from '../../../utils/pagination';
import { coerceCreateGoodsReceiveNoteBody } from './validate';
import { closedGrnIds, describeGrns } from './view';

// POST /admin/goods-receive-notes — record cards that arrived before their
// invoice (spec 2026-10-28). Raises the Stock page's On hand and, like an
// invoice, the Medusa stock counter. Rate-limited with the other admin money
// writers (middlewares.ts). Orders do not move on save: the 12am stock run
// (jobs/stock-allocation.ts) picks the new cards up.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = coerceCreateGoodsReceiveNoteBody(req.body);
  // Same gate as a purchase invoice: the form's FMV prefill is priced off
  // the FX rate, so refuse while that rate is unknown.
  await resolveFxRateStrict(
    req.scope.resolve<PacksModuleService>(PACKS_MODULE),
  );

  // Same existence gate as purchase-invoices/route.ts: every line must name a
  // real product handle.
  const productModule = req.scope.resolve(Modules.PRODUCT);
  const handles = [...new Set(body.lines.map((l) => l.card_handle))];
  const products = await productModule.listProducts(
    { handle: handles },
    { take: handles.length, select: ['handle'] },
  );
  const valid = new Set(products.map((p) => p.handle));
  const unknown = body.lines
    .map((l, i) => ({ i, card_handle: l.card_handle }))
    .filter(({ card_handle }) => !valid.has(card_handle));
  if (unknown.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Unknown card_handle — no matching product for ${unknown
        .map(({ i, card_handle }) => `lines[${i}] ('${card_handle}')`)
        .join(', ')}.`,
    );
  }

  const { result } = await createGoodsReceiveNoteWorkflow(req.scope).run({
    input: {
      date: body.date,
      supplier: body.supplier,
      agent_user_id: req.auth_context.actor_id,
      reverses_grn_id: null,
      lines: body.lines,
    },
  });
  res.status(201).json({ goods_receive_note: result });
}

const SORTABLE = new Set(['created_at', 'date', 'display_no', 'supplier']);
const STATUSES = new Set(['open']);

// GET /admin/goods-receive-notes — the GRN list. ?q= matches supplier or
// GRN number; ?status=open keeps only GRNs still waiting for their invoice
// (the invoice form's "transfer from goods receive note" picker).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 100 },
  );
  const rawQ = req.query.q;
  const rawStatus = req.query.status;
  if (rawQ !== undefined && typeof rawQ !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Invalid \`q\` filter '${String(rawQ)}'.`,
    );
  }
  if (
    rawStatus !== undefined &&
    (typeof rawStatus !== 'string' || !STATUSES.has(rawStatus))
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Invalid \`status\` filter '${String(rawStatus)}' (only 'open').`,
    );
  }
  // Truncate, then escape LIKE metacharacters — purchase-invoices/route.ts's
  // rule, for the same reasons.
  const q =
    typeof rawQ === 'string' && rawQ.trim() !== ''
      ? rawQ
          .trim()
          .slice(0, 100)
          .replace(/[\\%_]/g, (c) => `\\${c}`)
      : undefined;
  const { key: orderKey, dir: orderDir } = parseSortParam(
    req.query.sort,
    SORTABLE,
    'created_at',
  );

  const filter: Record<string, unknown> = q
    ? {
        $or: [
          { supplier: { $ilike: `%${q}%` } },
          { display_no: { $ilike: `%${q}%` } },
        ],
      }
    : {};
  if (rawStatus === 'open') {
    filter.reverses_grn_id = null;
    const closed = await closedGrnIds(packs);
    if (closed.length) filter.id = { $nin: closed };
  }

  const [grns, total] = await packs.listAndCountGoodsReceiveNotes(filter, {
    order: { [orderKey]: orderDir, id: orderDir },
    skip: offset,
    take: limit,
  });
  const rows = await describeGrns(req.scope, grns);
  res.json({
    total,
    offset,
    limit,
    // The list carries totals, not lines.
    goods_receive_notes: rows.map(({ lines: _lines, ...row }) => row),
  });
}
