import type {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { updateGoodsReceiveNoteWorkflow } from '../../../../workflows/update-goods-receive-note';
import { pageAll } from '../../../utils/page-all';
import { checkGrnLines, coerceEditGoodsReceiveNoteBody } from '../validate';
import { describeGrns } from '../view';

// GET /admin/goods-receive-notes/:id — one GRN with its lines, its status and
// the invoice / reversal it is linked to.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [grn] = await packs.listGoodsReceiveNotes(
    { id: req.params.id },
    { take: 1 },
  );
  if (!grn) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Goods receive note '${req.params.id}' not found.`,
    );
  }
  const [row] = await describeGrns(req.scope, [grn]);
  res.json({ goods_receive_note: row });
}

// POST /admin/goods-receive-notes/:id — edit an open GRN (owner 2026-11-03):
// date, supplier and every line, with the same body and checks as a new one.
// One already transferred to an invoice, reversed, or itself a reversal is
// refused under the GRN's lock (service.updateGoodsReceiveNoteWithLines).
// Orders do not move on save, the same as a new GRN.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = coerceEditGoodsReceiveNoteBody(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const current = await pageAll((opts) =>
    packs.listGoodsReceiveNoteLines({ grn_id: req.params.id }, opts),
  );
  await checkGrnLines(
    req.scope,
    body.lines,
    new Set(current.map((l) => l.card_handle)),
  );
  const { result } = await updateGoodsReceiveNoteWorkflow(req.scope).run({
    input: {
      grn_id: req.params.id,
      date: body.date,
      supplier: body.supplier,
      agent_user_id: req.auth_context.actor_id,
      expected_updated_at: body.expected_updated_at,
      lines: body.lines,
    },
  });
  // `delta` is the counter step's input, not part of the note.
  const { delta: _delta, ...grn } = result;
  res.json({ goods_receive_note: grn });
}
