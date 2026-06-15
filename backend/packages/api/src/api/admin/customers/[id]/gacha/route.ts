import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import type { ICustomerModuleService } from "@medusajs/framework/types";
import { PACKS_MODULE } from "../../../../../modules/packs";
import type PacksModuleService from "../../../../../modules/packs/service";
import { creditBalance } from "../../../../../modules/packs/credit-balance";
import { pageAll } from "../../../../utils/page-all";
import { toMoney } from "../../../../../modules/packs/money";

const RECENT = 50;

// GET /admin/customers/:id/gacha — the support view aggregate: one customer's
// identity, credit balance, recent ledger, recent pulls (card-joined like the
// admin pull ledger), and a vault summary (count + FMV currently owed). Reads
// only; the adjust POST lives at ../credits.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;

  const customerService: ICustomerModuleService = req.scope.resolve(
    Modules.CUSTOMER,
  );
  const [customer] = await customerService.listCustomers({ id }, { take: 1 });
  if (!customer) {
    res.status(404).json({ message: `Customer '${id}' not found` });
    return;
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const [balance, transactions, pulls, vaulted] = await Promise.all([
    creditBalance(packs, id),
    packs.listCreditTransactions(
      { customer_id: id },
      { order: { created_at: "DESC" }, take: RECENT },
    ),
    packs.listPulls(
      { customer_id: id },
      { order: { rolled_at: "DESC" }, take: RECENT },
    ),
    // Vault summary scans ALL vaulted pulls (not just the recent slice) so
    // the FMV-owed number is exact at any vault size.
    pageAll((opts) =>
      packs.listPulls({ customer_id: id, status: "vaulted" }, opts),
    ),
  ]);

  // Card join over both lists (handles are the stable key, like /store/vault).
  const handles = [...new Set([...pulls, ...vaulted].map((p) => p.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];
  const cardByHandle = new Map(cards.map((c) => [c.handle, c]));

  const vaultValueCents = vaulted.reduce((sum, p) => {
    const card = cardByHandle.get(p.card_id);
    const value = card ? toMoney(card.market_value) : 0;
    return sum + (Number.isFinite(value) ? Math.round(value * 100) : 0);
  }, 0);

  res.json({
    customer: {
      id: customer.id,
      email: customer.email,
      first_name: customer.first_name ?? null,
      created_at: customer.created_at,
    },
    balance,
    transactions: transactions.map((t) => ({
      id: t.id,
      amount: Number(t.amount),
      reason: t.reason,
      reference: t.reference ?? null,
      created_at: t.created_at,
    })),
    pulls: pulls.map((p) => {
      const card = cardByHandle.get(p.card_id);
      return {
        id: p.id,
        pack_id: p.pack_id,
        rolled_at: p.rolled_at,
        status: p.status,
        buyback_amount:
          p.buyback_amount === null ? null : Number(p.buyback_amount),
        card: card
          ? {
              handle: card.handle,
              name: card.name,
              market_value: toMoney(card.market_value),
              image: card.image,
            }
          : null,
      };
    }),
    vault: { count: vaulted.length, market_value: vaultValueCents / 100 },
  });
}
