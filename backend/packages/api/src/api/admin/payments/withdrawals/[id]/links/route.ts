import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../../../../../modules/packs";
import type PacksModuleService from "../../../../../../modules/packs/service";
import { findBank } from "../../../../../../modules/packs/banks";
import { PERMANENT_BAN_REASON_PREFIX } from "../../../../../utils/disabled-guard";
import { reportDb } from "../../../../../reports/sql";
import { playerView } from "../../../../../reports/support/ban/route";

type AccountRow = {
  id: string;
  handle: string | null;
  username: string | null;
  created_at: string;
  disabled: boolean | null;
  disabled_reason: string | null;
  topups: string;
  withdrawn: string;
  prize_sales: string;
  balance: string;
};

const rm = (v: string | number | null | undefined): number =>
  Math.round(Number(v ?? 0) * 100) / 100;

const accountView = (a: AccountRow) => ({
  id: a.id,
  handle: a.handle,
  username: a.username,
  created_at: new Date(a.created_at).toISOString(),
  disabled: a.disabled === true,
  banned: (a.disabled_reason ?? "").startsWith(PERMANENT_BAN_REASON_PREFIX),
  topups: rm(a.topups),
  withdrawn: rm(a.withdrawn),
  prize_sales: rm(a.prize_sales),
  balance: rm(a.balance),
});

// GET /admin/payments/withdrawals/:id/links: what a reviewer needs on one
// screen before approving or denying a held withdrawal (ADR 0018).
// - The accounts that share its browser or network, invited it, or were
//   invited by it, each with its money.
// - Every bank it saved or was paid to and who else used it, and accounts
//   under its holder names at other banks (support's ban-desk view).
// Gated by customer_bank_account:read (SECRET_READS) and audited as a reveal:
// it names other customers and their banks.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [row] = await packs.listGatewayWithdrawals(
    { id: req.params.id },
    { take: 1 },
  );
  if (!row?.customer_id) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Withdrawal '${req.params.id}' not found.`,
    );
  }
  const customerId = row.customer_id;
  const db = reportDb(req);

  const [player, visitors, browserPeers, holdPeers, referral] =
    await Promise.all([
      playerView(db, customerId),
      packs.visitorSignalMatches(customerId),
      packs.sharedBrowserAccounts(customerId),
      packs.sharedDeviceHoldPeers(customerId),
      db.raw<{ customer_id: string; referrer_id: string }>(
        "SELECT customer_id, referrer_id FROM referral_attribution WHERE (customer_id = ? OR referrer_id = ?) AND deleted_at IS NULL",
        [customerId, customerId],
      ),
    ]);
  const sameBrowser = new Set(browserPeers.map((p) => p.customer_id));
  const earlier = new Set(
    browserPeers.filter((p) => p.earlier).map((p) => p.customer_id),
  );
  const unverified = new Set(holdPeers);
  const sameNetwork = new Set(visitors.ip.flatMap((n) => n.customer_ids));
  const invitedBy = referral.rows.find(
    (r) => r.customer_id === customerId,
  )?.referrer_id;
  const invited = new Set(
    referral.rows
      .filter((r) => r.referrer_id === customerId)
      .map((r) => r.customer_id),
  );
  const ids = [
    ...new Set([
      customerId,
      ...sameBrowser,
      ...sameNetwork,
      ...invited,
      ...(invitedBy ? [invitedBy] : []),
    ]),
  ];

  // One row per account: who it is and its money, in RM.
  const accounts = (
    await db.raw<AccountRow>(
      `SELECT c.id, c.metadata->>'handle' AS handle, c.first_name AS username, c.created_at,
              s.disabled, s.disabled_reason,
              COALESCE((SELECT SUM(amount) FROM credit_transaction WHERE customer_id = c.id AND reason = 'topup' AND amount > 0 AND deleted_at IS NULL), 0) AS topups,
              COALESCE((SELECT SUM(amount) FROM gateway_withdrawal WHERE customer_id = c.id AND status = 'settled'), 0) AS withdrawn,
              COALESCE((SELECT SUM(ct.amount) FROM credit_transaction ct JOIN pull p ON p.id = ct.pull_id
                         WHERE ct.customer_id = c.id AND ct.reason = 'buyback' AND p.source IN ('reward', 'free') AND ct.deleted_at IS NULL), 0) AS prize_sales,
              COALESCE((SELECT SUM(amount) FROM credit_transaction WHERE customer_id = c.id AND deleted_at IS NULL), 0) AS balance
         FROM customer c
         LEFT JOIN customer_account_state s ON s.customer_id = c.id AND s.deleted_at IS NULL
        WHERE c.id = ANY(string_to_array(?, ','))`,
      [ids.join(",")],
    )
  ).rows;
  const me = accounts.find((a) => a.id === customerId);

  try {
    await packs.createAdminActionAudits([
      {
        admin_id: req.auth_context.actor_id,
        entity_type: "customer",
        entity_id: customerId,
        action: "reveal",
        before: null,
        // Counts only, never the banks or accounts it disclosed.
        after: {
          withdrawal: row.id,
          linked_accounts: ids.length - 1,
          bank_accounts: player.bank_accounts.length,
        },
        reason: "held withdrawal review",
      },
    ]);
  } catch {
    // The review still opens: a missing audit row must not block a payout decision.
  }

  res.setHeader("Cache-Control", "no-store");
  res.json({
    withdrawal: {
      id: row.id,
      amount: Number(row.amount),
      status: row.status,
      hold_reason: row.hold_reason ?? null,
      created_at: new Date(row.created_at).toISOString(),
      bank_name: findBank(row.bank_code)?.name ?? row.bank_code,
      last4: (row.account_number ?? "").slice(-4),
      holder_name: row.account_holder_name,
    },
    account: me ? accountView(me) : null,
    linked: accounts
      .filter((a) => a.id !== customerId)
      .map((a) => ({
        ...accountView(a),
        same_browser: sameBrowser.has(a.id),
        made_earlier_on_browser: earlier.has(a.id),
        // Support confirmed one household with this account: no hold for it.
        household_verified: earlier.has(a.id) && !unverified.has(a.id),
        same_network: sameNetwork.has(a.id),
        invited_this_account: a.id === invitedBy,
        invited_by_this_account: invited.has(a.id),
      }))
      .sort((x, y) => x.created_at.localeCompare(y.created_at)),
    // A crowded network lists only its first 10 accounts.
    networks_shared: visitors.ip_total,
    unsigned_requests: visitors.unsigned,
    bank_accounts: player.bank_accounts,
    same_name_accounts: player.same_name_accounts,
    unverified_peers: holdPeers.length,
  });
}
