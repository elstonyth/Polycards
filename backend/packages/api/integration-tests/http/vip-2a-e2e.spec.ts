import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { VIP_LEVELS } from "../../src/scripts/vip-levels.data";
import { unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

// Phase 2a release gate — 3 cases:
// 1. Recruit opens via the real HTTP route → sponsor wallet credited live.
// 2. Launder chain (earn commission → try to recycle as VIP basis) fails: the
//    commission credit never raises externalFundedSpendTotal (VIP basis).
// 3. Reconciliation: every commission lifecycle row maps to a
//    direct_referral/team_override credit row.

const PASSWORD = "vip-e2e-gate-pw1";

// Slug must be unique across the shared test DB — prefix avoids collision with
// pack-open-charge (poc-pack) and race (race-pack) fixtures.
const PACK_SLUG = "e2e-gate-pack";
const CARD_HANDLE = "e2e-gate-card";
const PACK_PRICE = 10;

medusaIntegrationTestRunner({
  inApp: true,
  env: { COMMISSION_COOLDOWN_DAYS: "0" }, // immediate maturity so sponsor wallet is available
  testSuite: ({ api, getContainer }) => {
    // ── helpers ────────────────────────────────────────────────────────────────

    // Seeds the VIP ladder (idempotent — mirrors direct-commission.spec.ts pattern).
    // Must be called at the start of any test that triggers settleOpen → levelForSpend.
    async function seedLadder(packs: PacksModuleService) {
      const existing = await packs.listVipLevels({}, { take: 1 });
      if (existing.length === 0) {
        await packs.createVipLevels(
          VIP_LEVELS.map((r) => ({
            level: r.level,
            spend_threshold: r.spend_threshold,
            voucher_amount: r.voucher_amount,
            box_tier: r.box_tier,
            frame_unlock: r.frame_unlock,
            direct_referral_pct: r.direct_referral_pct,
            prizes: r.prizes ?? null,
          })),
        );
      }
    }

    // Seeds the minimal priced pack fixture needed for the HTTP open route.
    // decrement-card-stock is best-effort (no-op when untracked), so no inventory
    // product/location/level is required. Called per-test to survive fresh DB isolation.
    async function seedPack(packs: PacksModuleService) {
      const existing = await packs.listPacks({ slug: PACK_SLUG }, { take: 1 });
      if (existing.length === 0) {
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: "E2E Gate Pack",
            category: "pokemon",
            price: PACK_PRICE,
            image: "/cdn/e2e-pack.webp",
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: "E2E Gate Card PSA 10",
            set: "E2E Set",
            grader: "PSA",
            grade: "10",
            market_value: 50,
            image: "/cdn/e2e-card.webp",
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: "Rare" as const,
          },
        ]);
      }
    }

    // Publishable API key — required by /auth and /store/* routes.
    // Minted per-test because the runner provides a fresh DB.
    async function mintStoreHeaders(): Promise<Record<string, string>> {
      const apiKeyModule = getContainer().resolve(Modules.API_KEY);
      const key = await apiKeyModule.createApiKeys({
        title: "vip-e2e-gate-test",
        type: "publishable",
        created_by: "vip-e2e-gate-test",
      });
      return { "x-publishable-api-key": key.token };
    }

    // Register a real Medusa customer and return bearer token + Medusa customer id.
    // Mirrors referral-route.spec.ts and pack-open-charge.spec.ts.
    // actorId = req.auth_context.actor_id on authenticated /store/* requests.
    async function registerAndLogin(
      email: string,
      storeHeaders: Record<string, string>,
    ): Promise<{ token: string; actorId: string }> {
      const reg = await api.post("/auth/customer/emailpass/register", {
        email,
        password: PASSWORD,
      });
      const created = await api.post(
        "/store/customers",
        { email },
        {
          headers: {
            ...storeHeaders,
            authorization: `Bearer ${reg.data.token}`,
          },
        },
      );
      const login = await api.post("/auth/customer/emailpass", {
        email,
        password: PASSWORD,
      });
      return {
        token: login.data.token as string,
        actorId: created.data.customer.id as string,
      };
    }

    // ── Gate test 1: recruit → sponsor → wallet (real HTTP open route) ────────
    it(
      "recruit → sponsor → wallet loop completes through the real HTTP open route",
      async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);
        await seedPack(packs);
        const storeHeaders = await mintStoreHeaders();

        // Two real Medusa customers: sponsor and recruit.
        const sponsor = await registerAndLogin("e2e-sponsor@pokenic.test", storeHeaders);
        const recruit = await registerAndLogin("e2e-recruit@pokenic.test", storeHeaders);

        // Recruit registers sponsor via POST /store/referral (Task 11 route).
        const refRes = await unwrapResponse(
          api.post(
            "/store/referral",
            { sponsor_id: sponsor.actorId },
            {
              headers: {
                ...storeHeaders,
                authorization: `Bearer ${recruit.token}`,
              },
            },
          ),
        );
        expect(refRes.status).toBe(201);

        // Recruit tops up externally (mutateCreditAtomic with reason "topup"
        // so the spend is external-funded and commissionable).
        await packs.mutateCreditAtomic({
          customerId: recruit.actorId,
          amount: PACK_PRICE * 2, // headroom for the open (2x price)
          reason: "topup",
          reference: "mock_e2e_gate",
        });

        // Recruit opens via the REAL HTTP route: POST /store/packs/:slug/open.
        // The route calls openPackWorkflow which calls settleOpen (Task 14)
        // which credits the sponsor in the same transaction.
        const openRes = await unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open`,
            {},
            {
              headers: {
                ...storeHeaders,
                authorization: `Bearer ${recruit.token}`,
              },
            },
          ),
        );
        expect(openRes.status).toBe(200);
        expect(openRes.data.price).toBe(PACK_PRICE);

        // Sponsor wallet must be credited now (cooldown=0 → immediately available).
        // At L1 (externalFundedSpendTotal=0), pct=1% → PACK_PRICE × 1% = 0.10 RM = 10 sen.
        const sponsorAvailable = await packs.availableBalance(sponsor.actorId);
        expect(sponsorAvailable).toBeGreaterThan(0);

        // Commission lifecycle row must exist and be available (matured).
        const comms = await packs.listCommissions(
          { beneficiary: sponsor.actorId },
          { take: 5 },
        );
        expect(comms.length).toBeGreaterThan(0);
        expect(comms[0].generation).toBe(1);
      },
    );

    // ── Gate test 2: launder chain cannot beat external-in ────────────────────
    // A sponsor earns commission (internal credit). Their externalFundedSpendTotal
    // (VIP basis) must stay 0 — commission is NOT external-funded, so recycling
    // it back as an open cannot inflate the basis.
    it(
      "launder chain: commission credit never raises VIP basis (externalFundedSpendTotal=0)",
      async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        // Seed the ladder: settleOpen calls levelForSpend which requires it.
        await seedLadder(packs);

        const sponsorId = "cus_launder_sponsor_gate";
        const recruitId = "cus_launder_recruit_gate";

        // Wire the relationship directly (no HTTP needed for this invariant test).
        await packs.linkSponsor({ recruitId, sponsorId });

        // Recruit tops up and opens — triggers commission to sponsor.
        await packs.mutateCreditAtomic({
          customerId: recruitId,
          amount: 100,
          reason: "topup",
          reference: "mock_launder_gate",
        });
        await packs.settleOpen({
          customerId: recruitId,
          amount: -100,
          sourceTransactionId: "open_launder_gate_1",
        });

        // Sponsor now has commission credit in their balance.
        const sponsorBalance = await packs.creditBalance(sponsorId);
        expect(sponsorBalance).toBeGreaterThan(0); // has some commission credit

        // THE INVARIANT: sponsor's VIP basis (externalFundedSpendTotal) is still 0.
        // Commission rows carry reason "direct_referral", which is NOT "topup" and
        // NOT "pack_open" — foldLedgerRow only increments externalFundedSpendCents
        // on pack_open rows (the external-funded portion). So recycling commission
        // into an open would require external funds, not the commission itself.
        const summary = await packs.creditSummary(sponsorId);
        expect(summary.externalFundedSpendTotal).toBe(0); // basis never inflated

        // Also: topupTotal for the sponsor must be 0 (they received only commission,
        // not any top-up). This confirms the "can't beat external-in" invariant:
        // their available balance is purely commission-derived, not externally funded.
        expect(summary.topupTotal).toBe(0);
        expect(summary.balance).toBe(sponsorBalance); // consistent with creditBalance
      },
    );

    // ── Gate test 3: reconciliation (every commission row → credit row) ───────
    // For every Commission lifecycle record, there must be a CreditTransaction row
    // with reason direct_referral or team_override.
    it(
      "reconciliation: every commission lifecycle row maps to a credit row",
      async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);

        // Seed at least one commission so the reconciliation loop has data.
        const sponsorId = "cus_recon_sponsor";
        const recruitId = "cus_recon_recruit";
        await packs.linkSponsor({ recruitId, sponsorId });
        await packs.mutateCreditAtomic({
          customerId: recruitId,
          amount: 50,
          reason: "topup",
          reference: "mock_recon",
        });
        await packs.settleOpen({
          customerId: recruitId,
          amount: -50,
          sourceTransactionId: "open_recon_1",
        });

        const comms = await packs.listCommissions({}, { take: 10_000 });

        // At least one commission must exist (from the seed above).
        expect(comms.length).toBeGreaterThan(0);

        for (const c of comms) {
          // Every commission must have a linked credit transaction id.
          expect(c.credit_transaction_id).toBeTruthy();

          const [credit] = await packs.listCreditTransactions(
            { id: c.credit_transaction_id },
            { take: 1 },
          );

          // Credit row must exist.
          expect(credit).toBeDefined();
          // Reason must be one of the two commission buckets.
          expect(credit.reason).toMatch(/direct_referral|team_override/);
        }
      },
    );
  },
});
