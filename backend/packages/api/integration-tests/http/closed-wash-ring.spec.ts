import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";

jest.setTimeout(240 * 1000);

// Phase 1b RELEASE GATE (spec §16): a closed ring of accounts, each funded by a
// fixed external top-up, cycling credit through opens + buybacks, can NEVER
// raise its external-funded VIP basis above its own top-ups, and the ring's net
// credit can never exceed total external money in. This is the property the
// external-funded counter exists to guarantee.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe("closed wash-ring cannot inflate VIP basis or net credit", () => {
      it("external basis stays ≤ top-ups despite buyback recycling", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const TOPUP = 100; // RM each
        const RING = ["cus_ring_a", "cus_ring_b", "cus_ring_c"];

        for (const cust of RING) {
          // NOTE: credit is strictly per-customer — this system has NO inter-account
          // transfer primitive, so a "ring" here is each account self-recycling
          // (open → buyback → open). That IS the complete wash threat surface today;
          // if an inter-account transfer is ever added, this gate must be extended.

          // 1) Fixed external top-up.
          await packs.mutateCreditAtomic({
            customerId: cust,
            amount: TOPUP,
            reason: "topup",
            reference: "mock_ring",
          });
          // 2) Recycle: open, "sell back" (buyback credit), open again — many
          //    times. Buyback returns <100% so balance only ever shrinks.
          let pullSeq = 0;
          for (let i = 0; i < 5; i++) {
            const bal = await packs.creditBalance(cust);
            if (bal < 10) break;
            const open = Math.min(bal, 30);
            await packs.mutateCreditAtomic({
              customerId: cust,
              amount: -open,
              reason: "pack_open",
              sourceTransactionId: `open_wash_${cust}_${i}`,
              floor: 0,
            });
            // Buyback at 90% — internal credit, NOT external.
            await packs.createCreditTransactions([
              {
                customer_id: cust,
                amount: open * 0.9,
                reason: "buyback" as const,
                pull_id: `pull_${cust}_${pullSeq++}`,
                reference: null,
              },
            ]);
          }

          const summary = await packs.creditSummary(cust);
          // RELEASE GATE: external-funded basis never exceeds the top-up.
          expect(summary.externalFundedSpendTotal).toBeLessThanOrEqual(TOPUP);
          // Net credit (balance) never exceeds external money in.
          expect(summary.balance).toBeLessThanOrEqual(TOPUP);
          // Concrete, non-circular assertions (the loop is deterministic):
          // Re-derive external balance from the ledger to assert it directly.
          const rows = await packs.listCreditTransactions(
            { customer_id: cust },
            { take: 1000, order: { created_at: "ASC" } },
          );
          const extInCents = rows
            .filter((r) => r.reason === "topup")
            .reduce(
              (s, r) =>
                s +
                Math.round(
                  Number(
                    (r as { external_funded_cents?: number | null })
                      .external_funded_cents ?? 0,
                  ),
                ),
              0,
            );
          const extBalanceCents = rows.reduce(
            (s, r) =>
              s +
              Math.round(
                Number(
                  (r as { external_funded_cents?: number | null })
                    .external_funded_cents ?? 0,
                ),
              ),
            0,
          );
          // The single top-up stamped the full external-in...
          expect(extInCents).toBe(TOPUP * 100); // 10000 sen
          // ...every sen of it was consumed by opens (external balance drained)...
          expect(extBalanceCents).toBe(0);
          // ...so the VIP basis equals exactly the external top-up — the cap binds.
          expect(summary.externalFundedSpendTotal).toBe(TOPUP);
        }
      });
    });
  },
});
