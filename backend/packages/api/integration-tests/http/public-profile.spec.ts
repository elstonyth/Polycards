import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { HANDLE_RE } from "../../src/utils/profile-handle";
import { clearProfileCache } from "../../src/api/store/profiles/[handle]/route";
import { myrDisplay as MYR, unwrapResponse } from "./utils";

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
// multiplier, so values follow the shared myrDisplay helper (see utils).

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
        // The route's per-process 30s profile cache outlives each test's
        // fixtures (one jest process = one module instance) — clear it so a
        // previous test's profile is never served against this test's data.
        clearProfileCache();

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
            rarity: "Mythical" as const,
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
          by_rarity: {
            Immortal: 0,
            Legendary: 0,
            Mythical: 1,
            Rare: 2,
            Uncommon: 0,
            Common: 0,
          },
        });

        // Recent pulls: newest first, card display fields + per-pack rarity.
        expect(p.recent).toHaveLength(3);
        expect(p.recent[0]).toMatchObject({
          rarity: "Mythical",
          pack_id: PACK_SLUG,
          card: {
            handle: EPIC_CARD,
            name: "PP Epic BGS 10",
            grader: "BGS",
            grade: "10",
            market_value: EPIC_FMV,
            // The live MYR display value the storefront prefers over raw USD.
            marketPriceMyr: MYR(EPIC_FMV),
            image: "/cdn/epic.webp",
          },
        });
        expect(p.recent[1].card.handle).toBe(RARE_CARD);
        expect(typeof p.recent[0].rolled_at).toBe("string");
      });

      // Plan 022 parity pin: the stats now come from a SQL aggregate
      // (profileStatsForCustomer) — this seeds ≥2 packs and ≥2 rarities plus a
      // reward pull and asserts the exact values the old in-route JS fold
      // produced, computed here from the seeded data.
      it("stats parity: SQL aggregate matches the seeded data across packs/rarities; reward pulls excluded (C1)", async () => {
        const container = getContainer();
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const customerModule = container.resolve(Modules.CUSTOMER);

        // Second pack: the SAME card is a different rarity here — pins that
        // by_rarity resolves per (pack, card) odds row, not per card.
        const PACK2_SLUG = "pp-pack-2";
        await packs.createPacks([
          {
            slug: PACK2_SLUG,
            title: "PP Test Pack 2",
            category: "pokemon",
            price: PACK_PRICE,
            image: "/cdn/test-pack-2.webp",
            buyback_percent: 90,
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK2_SLUG,
            card_id: RARE_CARD,
            weight: 100,
            rarity: "Legendary" as const,
          },
        ]);

        const parity = await customerModule.createCustomers({
          email: "pp-parity@test.dev",
          first_name: "Parity",
          metadata: { handle: "parity-test" },
        });
        await packs.createPulls([
          {
            customer_id: parity.id,
            pack_id: PACK_SLUG,
            card_id: RARE_CARD,
            rolled_at: new Date("2026-06-01T10:00:00Z"),
          },
          {
            customer_id: parity.id,
            pack_id: PACK_SLUG,
            card_id: RARE_CARD,
            rolled_at: new Date("2026-06-02T10:00:00Z"),
          },
          {
            customer_id: parity.id,
            pack_id: PACK_SLUG,
            card_id: EPIC_CARD,
            rolled_at: new Date("2026-06-03T10:00:00Z"),
          },
          {
            customer_id: parity.id,
            pack_id: PACK2_SLUG,
            card_id: RARE_CARD,
            rolled_at: new Date("2026-06-04T10:00:00Z"),
          },
          // Reward pull, NEWEST row: if the C1 source filter leaked, this
          // would bump pulls/by_rarity AND take recent[0].
          {
            customer_id: parity.id,
            pack_id: PACK_SLUG,
            card_id: RARE_CARD,
            rolled_at: new Date("2026-06-05T10:00:00Z"),
            source: "reward" as const,
          },
        ] as Parameters<typeof packs.createPulls>[0]);
        await packs.createCreditTransactions(
          Array.from({ length: 4 }, () => ({
            customer_id: parity.id,
            amount: -PACK_PRICE,
            reason: "pack_open" as const,
          })) as Parameters<typeof packs.createCreditTransactions>[0],
        );

        const res = await getProfile("parity-test");
        expect(res.status).toBe(200);
        expect(res.data.stats).toEqual({
          pulls: 4, // reward pull excluded
          // Per-card rounding (MYR rounds each card), summed — the old fold.
          volume:
            Math.round((3 * MYR(RARE_FMV) + MYR(EPIC_FMV)) * 100) / 100,
          by_rarity: {
            Immortal: 0,
            Legendary: 1, // RARE_CARD pulled from pack 2
            Mythical: 1,
            Rare: 2,
            Uncommon: 0,
            Common: 0,
          },
        });
        // Recent feed also excludes the reward pull: newest entry is the
        // pack-2 pull, not the (newer) reward row.
        expect(res.data.recent).toHaveLength(4);
        expect(res.data.recent[0]).toMatchObject({
          pack_id: PACK2_SLUG,
          rarity: "Legendary",
          card: { handle: RARE_CARD },
        });
      });

      it("recent feed: newest-first, 12 max, deleted-card pulls skipped without under-filling", async () => {
        const container = getContainer();
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const customerModule = container.resolve(Modules.CUSTOMER);

        const customer = await customerModule.createCustomers({
          email: "pp-recent@test.dev",
          first_name: "Recent",
          metadata: { handle: "recent-test" },
        });

        // A card that will be deleted AFTER its pulls are recorded. 30 pulls
        // of it sit NEWEST, so the first recent page (3×12=36) yields only 6
        // survivors and the route must page again (the under-fill guard).
        const DOOMED_CARD = "pp-card-doomed";
        const [doomed] = await packs.createCards([
          {
            handle: DOOMED_CARD,
            name: "PP Doomed",
            set: "Test Set",
            grader: "PSA",
            grade: "8",
            market_value: 5,
            image: "/cdn/doomed.webp",
          },
        ]);
        const doomedPulls = Array.from({ length: 30 }, (_, i) => ({
          customer_id: customer.id,
          pack_id: PACK_SLUG,
          card_id: DOOMED_CARD,
          rolled_at: new Date(Date.UTC(2026, 5, 10, 0, i)), // newest block
        }));
        const rarePulls = Array.from({ length: 13 }, (_, i) => ({
          customer_id: customer.id,
          pack_id: PACK_SLUG,
          card_id: RARE_CARD,
          rolled_at: new Date(Date.UTC(2026, 5, 1, 0, i)), // older block
        }));
        await packs.createPulls([...doomedPulls, ...rarePulls]);
        await packs.softDeleteCards([doomed.id]);

        const res = await getProfile("recent-test");
        expect(res.status).toBe(200);

        // Filter-before-slice: the 30 newest (deleted-card) pulls are skipped
        // and the feed still fills to 12 from the older survivors.
        expect(res.data.recent).toHaveLength(12);
        for (const entry of res.data.recent) {
          expect(entry.card.handle).toBe(RARE_CARD);
        }
        const times = res.data.recent.map((r: { rolled_at: string }) =>
          new Date(r.rolled_at).getTime(),
        );
        expect(times).toEqual([...times].sort((a, b) => b - a)); // newest first

        // Deleted-card pulls still COUNT in the stats (volume contributes 0,
        // rarity falls back to 'Common' — no odds row was seeded for it).
        expect(res.data.stats.pulls).toBe(43);
        expect(res.data.stats.volume).toBe(
          Math.round(13 * MYR(RARE_FMV) * 100) / 100,
        );
        expect(res.data.stats.by_rarity).toMatchObject({
          Rare: 13,
          Common: 30,
        });
      });

      it("caches the body per handle for the TTL; clearProfileCache() makes new pulls visible", async () => {
        const first = await getProfile(SEEDED_HANDLE);
        expect(first.status).toBe(200);
        expect(first.data.stats.pulls).toBe(3);

        // Two consecutive GETs serve the identical body.
        const second = await getProfile(SEEDED_HANDLE);
        expect(second.data).toEqual(first.data);

        // A new pull lands... but the cached body is what's served (≤30s
        // staleness is the accepted tolerance, same as the leaderboard).
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPulls([
          {
            customer_id: seededCustomerId,
            pack_id: PACK_SLUG,
            card_id: RARE_CARD,
            rolled_at: new Date("2026-06-06T10:00:00Z"),
          },
        ]);
        const stillCached = await getProfile(SEEDED_HANDLE);
        expect(stillCached.data).toEqual(first.data);

        // Past the cache, the new pull is visible.
        clearProfileCache();
        const fresh = await getProfile(SEEDED_HANDLE);
        expect(fresh.data.stats.pulls).toBe(4);
        expect(fresh.data.recent[0].card.handle).toBe(RARE_CARD);
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

      // The storefront draws the tier frame from collection[].rarity, so it
      // must resolve per (pack, card) odds row — the SAME card is seeded at a
      // different rarity in a second pack here, which is what a cross-product
      // odds lookup would get wrong.
      it("showcased collection items carry the per-(pack, card) rarity", async () => {
        const container = getContainer();
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const customerModule = container.resolve(Modules.CUSTOMER);

        const SHOWCASE_PACK = "pp-showcase-pack";
        await packs.createPacks([
          {
            slug: SHOWCASE_PACK,
            title: "PP Showcase Pack",
            category: "pokemon",
            price: PACK_PRICE,
            image: "/cdn/showcase-pack.webp",
            buyback_percent: 90,
          },
        ]);
        // RARE_CARD is "Rare" in PACK_SLUG — here it is Immortal.
        await packs.createPackOdds([
          {
            pack_id: SHOWCASE_PACK,
            card_id: RARE_CARD,
            weight: 100,
            rarity: "Immortal" as const,
          },
        ]);

        const collector = await customerModule.createCustomers({
          email: "pp-showcase@test.dev",
          first_name: "Showcase",
          metadata: { handle: "showcase-test" },
        });
        await packs.createPulls([
          {
            customer_id: collector.id,
            pack_id: SHOWCASE_PACK,
            card_id: RARE_CARD,
            rolled_at: new Date("2026-06-04T10:00:00Z"),
            status: "vaulted" as const,
            showcased: true,
          },
          // Not showcased — must not appear in the collection at all.
          {
            customer_id: collector.id,
            pack_id: PACK_SLUG,
            card_id: EPIC_CARD,
            rolled_at: new Date("2026-06-05T10:00:00Z"),
            status: "vaulted" as const,
          },
        ]);

        const res = await getProfile("showcase-test");
        expect(res.status).toBe(200);
        expect(res.data.collection).toHaveLength(1);
        expect(res.data.collection[0]).toMatchObject({
          handle: RARE_CARD,
          rarity: "Immortal",
        });
      });
    });
  },
});
