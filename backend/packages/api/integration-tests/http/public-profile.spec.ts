import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { HANDLE_RE } from "../../src/utils/profile-handle";
import { unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

const PASSWORD = "pp-test-password-1";

// Fixture constants. Clean integer FMVs so volume needs no float care in the
// assertions (the route rounds like the leaderboard does).
const PACK_SLUG = "pp-pack";
const PACK_PRICE = 10;
const RARE_CARD = "pp-card-rare";
const RARE_FMV = 50;
const EPIC_CARD = "pp-card-epic";
const EPIC_FMV = 10;

// volume is the MYR display value (FMV × multiplier × FX), matching the
// leaderboard. No FxRate row is seeded and cards carry the model-default
// multiplier, so it's FMV × 1.2 (DEFAULT_MARKET_MULTIPLIER) × 4.7
// (DEFAULT_USD_MYR).
const MYR = (usd: number) => Math.round(usd * 1.2 * 4.7 * 100) / 100;

const SEEDED_HANDLE = "kenji-test";
const SEEDED_EMAIL = "pp-collector@test.dev";
const SEEDED_NAME = "Kenji";

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe("public profiles (GET /store/profiles/:handle)", () => {
      let storeHeaders: Record<string, string>;
      let seededCustomerId: string;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: "public-profile-test",
          type: "publishable",
          created_by: "public-profile-test",
        });
        storeHeaders = { "x-publishable-api-key": key.token };

        // Gacha fixtures: one pack, two cards at different rarities.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: "PP Test Pack",
            category: "pokemon",
            price: PACK_PRICE,
            image: "/cdn/test-pack.webp",
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: RARE_CARD,
            name: "PP Rare PSA 9",
            set: "Test Set",
            grader: "PSA",
            grade: "9",
            market_value: RARE_FMV,
            image: "/cdn/rare.webp",
          },
          {
            handle: EPIC_CARD,
            name: "PP Epic BGS 10",
            set: "Test Set",
            grader: "BGS",
            grade: "10",
            market_value: EPIC_FMV,
            image: "/cdn/epic.webp",
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: RARE_CARD,
            weight: 90,
            rarity: "Rare" as const,
          },
          {
            pack_id: PACK_SLUG,
            card_id: EPIC_CARD,
            weight: 10,
            rarity: "Epic" as const,
          },
        ]);

        // A "seeded demo collector": customer with a pre-assigned
        // metadata.handle (exactly what seed.ts does) and a pull history
        // written straight to the ledger — no opens/credits needed.
        const customerModule = container.resolve(Modules.CUSTOMER);
        const seeded = await customerModule.createCustomers({
          email: SEEDED_EMAIL,
          first_name: SEEDED_NAME,
          metadata: { handle: SEEDED_HANDLE },
        });
        seededCustomerId = seeded.id;

        await packs.createPulls([
          {
            customer_id: seededCustomerId,
            pack_id: PACK_SLUG,
            card_id: RARE_CARD,
            rolled_at: new Date("2026-06-01T10:00:00Z"),
          },
          {
            customer_id: seededCustomerId,
            pack_id: PACK_SLUG,
            card_id: RARE_CARD,
            rolled_at: new Date("2026-06-02T10:00:00Z"),
          },
          {
            customer_id: seededCustomerId,
            pack_id: PACK_SLUG,
            card_id: EPIC_CARD,
            rolled_at: new Date("2026-06-03T10:00:00Z"),
          },
        ]);
        // Matching pack_open ledger debits — points come from REAL spend now
        // (the same basis as the leaderboard), not from re-joining pack price.
        await packs.createCreditTransactions(
          Array.from({ length: 3 }, () => ({
            customer_id: seededCustomerId,
            amount: -PACK_PRICE,
            reason: "pack_open" as const,
          })) as Parameters<typeof packs.createCreditTransactions>[0],
        );
      });

      const getProfile = (handle: string) =>
        unwrapResponse(
          api.get(`/store/profiles/${handle}`, { headers: storeHeaders }),
        );

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post("/auth/customer/emailpass/register", {
          email,
          password: PASSWORD,
        });
        await api.post(
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
        return login.data.token;
      };

      it("returns the safe-public profile of a seeded collector", async () => {
        const res = await getProfile(SEEDED_HANDLE);
        expect(res.status).toBe(200);

        const p = res.data;
        expect(p.handle).toBe(SEEDED_HANDLE);
        expect(p.name).toBe(SEEDED_NAME);
        expect(typeof p.seed).toBe("number");
        expect(typeof p.joined_at).toBe("string");

        expect(p.stats).toEqual({
          pulls: 3,
          volume: Math.round((2 * MYR(RARE_FMV) + MYR(EPIC_FMV)) * 100) / 100,
          points: 3 * PACK_PRICE * 100,
          by_rarity: {
            Legendary: 0,
            Epic: 1,
            Rare: 2,
            Uncommon: 0,
            Common: 0,
          },
        });

        // Recent pulls: newest first, card display fields + per-pack rarity.
        expect(p.recent).toHaveLength(3);
        expect(p.recent[0]).toMatchObject({
          rarity: "Epic",
          pack_id: PACK_SLUG,
          card: {
            handle: EPIC_CARD,
            name: "PP Epic BGS 10",
            grader: "BGS",
            grade: "10",
            market_value: EPIC_FMV,
            image: "/cdn/epic.webp",
          },
        });
        expect(p.recent[1].card.handle).toBe(RARE_CARD);
        expect(typeof p.recent[0].rolled_at).toBe("string");
      });

      it("never leaks PII (email, customer id, credit/vault fields)", async () => {
        const res = await getProfile(SEEDED_HANDLE);
        expect(res.status).toBe(200);

        const raw = JSON.stringify(res.data);
        expect(raw).not.toContain(SEEDED_EMAIL);
        expect(raw).not.toContain(seededCustomerId);
        expect(raw).not.toContain("email");
        expect(raw).not.toContain("balance");
        expect(raw).not.toContain("buyback");
        expect(raw.toLowerCase()).not.toContain("vault");
      });

      it("404s an unknown or malformed handle", async () => {
        expect((await getProfile("no-such-collector-zz")).status).toBe(404);
        // Malformed param (uppercase / junk) is also a 404, not a 500.
        expect((await getProfile("NOT%20a%20handle")).status).toBe(404);
      });

      it("GET /store/profiles/me requires auth and lazily assigns a stable handle", async () => {
        const unauthed = await unwrapResponse(
          api.get("/store/profiles/me", { headers: storeHeaders }),
        );
        expect(unauthed.status).toBe(401);

        const token = await registerCustomer("pp-fresh@test.dev");
        const authedHeaders = {
          ...storeHeaders,
          authorization: `Bearer ${token}`,
        };

        const first = await unwrapResponse(
          api.get("/store/profiles/me", { headers: authedHeaders }),
        );
        expect(first.status).toBe(200);
        expect(first.data.handle).toMatch(HANDLE_RE);

        // Stable across calls (persisted, not re-rolled).
        const second = await unwrapResponse(
          api.get("/store/profiles/me", { headers: authedHeaders }),
        );
        expect(second.data.handle).toBe(first.data.handle);

        // The lazily-assigned handle resolves publicly (zero pulls yet).
        const pub = await getProfile(first.data.handle);
        expect(pub.status).toBe(200);
        expect(pub.data.stats.pulls).toBe(0);
        expect(pub.data.recent).toEqual([]);
      });
    });
  },
});
