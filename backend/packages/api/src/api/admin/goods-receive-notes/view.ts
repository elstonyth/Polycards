import { Modules } from '@medusajs/framework/utils';
import type {
  IUserModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { fromSen, toSen } from '../../../modules/packs/money';
import { pageAll } from '../../utils/page-all';

// open        — received, waiting for its invoice
// transferred — an invoice was made from it ("transfer from goods receive note")
// reversed    — undone by a reversal GRN
// reversal    — this GRN IS the reversal of another
export type GrnStatus = 'open' | 'transferred' | 'reversed' | 'reversal';

type Grn = Awaited<
  ReturnType<PacksModuleService['listGoodsReceiveNotes']>
>[number];
type Ref = { id: string; display_no: string };
type Invoice = Awaited<
  ReturnType<PacksModuleService['listPurchaseInvoices']>
>[number];

// GRN id -> the invoice it is transferred into right now. Takes every invoice
// carrying a from_grn_id, reversals included: a transfer whose invoice has
// been reversed (always in full) no longer counts, and the GRN is open again
// — the same rule as service.goodsReceiveNoteTransfer.
const liveTransfers = (invoices: Invoice[]): Map<string, Invoice> => {
  const reversed = new Set(invoices.map((i) => i.reverses_invoice_id));
  return new Map(
    invoices
      .filter((i) => !i.reverses_invoice_id && !reversed.has(i.id))
      .map((i) => [i.from_grn_id as string, i]),
  );
};

// The ids no longer open: reversed ones and transferred ones. Feeds the list's
// ?status=open filter (the invoice form's GRN picker).
// shortcut: reads every reversal GRN and every transferred invoice id; upgrade
// to a NOT EXISTS query if GRNs ever number in the tens of thousands.
export async function closedGrnIds(
  packs: PacksModuleService,
): Promise<string[]> {
  const reversals = await pageAll((opts) =>
    packs.listGoodsReceiveNotes(
      { reverses_grn_id: { $ne: null } },
      { ...opts, select: ['id', 'reverses_grn_id'] },
    ),
  );
  const transfers = await pageAll((opts) =>
    packs.listPurchaseInvoices(
      { from_grn_id: { $ne: null } },
      { ...opts, select: ['id', 'from_grn_id', 'reverses_invoice_id'] },
    ),
  );
  return [
    ...reversals.map((g) => g.reverses_grn_id as string),
    ...liveTransfers(transfers).keys(),
  ];
}

// Status, links and totals for a page of GRNs — one batched read per
// relation, never per row.
export async function describeGrns(container: MedusaContainer, grns: Grn[]) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const ids = grns.map((g) => g.id);
  const lines = ids.length
    ? await pageAll((opts) =>
        packs.listGoodsReceiveNoteLines({ grn_id: ids }, opts),
      )
    : [];
  const reversals = ids.length
    ? await pageAll((opts) =>
        packs.listGoodsReceiveNotes({ reverses_grn_id: ids }, opts),
      )
    : [];
  const invoices = ids.length
    ? await pageAll((opts) =>
        packs.listPurchaseInvoices({ from_grn_id: ids }, opts),
      )
    : [];
  const reversedTargets = [
    ...new Set(grns.map((g) => g.reverses_grn_id).filter(Boolean)),
  ] as string[];
  const targets = reversedTargets.length
    ? await packs.listGoodsReceiveNotes(
        { id: reversedTargets },
        { take: reversedTargets.length },
      )
    : [];
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const agentIds = [...new Set(grns.map((g) => g.agent_user_id))];
  const agents = agentIds.length
    ? await users.listUsers({ id: agentIds }, { take: agentIds.length })
    : [];

  const ref = (r: { id: string; display_no: string }): Ref => ({
    id: r.id,
    display_no: r.display_no,
  });
  const linesBy = new Map<string, typeof lines>();
  for (const l of lines) linesBy.set(l.grn_id, [...(linesBy.get(l.grn_id) ?? []), l]);
  const reversalBy = new Map(
    reversals.map((r) => [r.reverses_grn_id as string, ref(r)]),
  );
  const invoiceBy = new Map(
    [...liveTransfers(invoices)].map(([grnId, i]) => [grnId, ref(i)]),
  );
  const targetBy = new Map(targets.map((t) => [t.id, ref(t)]));
  const emailBy = new Map(agents.map((u) => [u.id, u.email]));

  return grns.map((g) => {
    const own = linesBy.get(g.id) ?? [];
    const reversedBy = reversalBy.get(g.id) ?? null;
    const invoice = invoiceBy.get(g.id) ?? null;
    const status: GrnStatus = g.reverses_grn_id
      ? 'reversal'
      : reversedBy
        ? 'reversed'
        : invoice
          ? 'transferred'
          : 'open';
    return {
      id: g.id,
      display_no: g.display_no,
      date: g.date,
      supplier: g.supplier,
      agent_user_id: g.agent_user_id,
      agent_email: emailBy.get(g.agent_user_id) ?? null,
      created_at: g.created_at,
      status,
      invoice,
      reversed_by: reversedBy,
      reverses: g.reverses_grn_id
        ? (targetBy.get(g.reverses_grn_id) ?? null)
        : null,
      total_qty: own.reduce((s, l) => s + Number(l.qty), 0),
      // sen × integer qty stays exact (validate.ts caps fmv at 2dp), the same
      // rule purchase-invoices/route.ts's total_fmv follows.
      total_fmv: fromSen(
        own.reduce((s, l) => s + toSen(l.fmv_snapshot) * Number(l.qty), 0),
      ),
      lines: own,
    };
  });
}
