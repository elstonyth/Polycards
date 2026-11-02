import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { createGoodsReceiveNoteWorkflow } from '../../../../../workflows/create-goods-receive-note';
import { pageAll } from '../../../../utils/page-all';

// POST /admin/goods-receive-notes/:id/reverse — undo a GRN that was booked by
// mistake: a new GRN whose lines negate every line of this one (spec
// 2026-10-28, same correction model as purchase invoices). Only an OPEN GRN
// can be reversed; the service re-checks that under the GRN's lock.
export async function POST(
  req: AuthenticatedMedusaRequest,
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
  const lines = await pageAll((opts) =>
    packs.listGoodsReceiveNoteLines({ grn_id: grn.id }, opts),
  );
  const { result } = await createGoodsReceiveNoteWorkflow(req.scope).run({
    input: {
      date: new Date().toISOString(),
      supplier: grn.supplier,
      agent_user_id: req.auth_context.actor_id,
      reverses_grn_id: grn.id,
      lines: lines.map((l) => ({
        card_handle: l.card_handle,
        card_name: l.card_name,
        fmv_snapshot: Number(l.fmv_snapshot),
        qty: -Number(l.qty),
      })),
    },
  });
  res.status(201).json({ goods_receive_note: result });
}
