# Live Market Price (PriceCharting) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin creates a product by searching PriceCharting (on a custom admin page); the PriceCharting link is stored on the product and carries through Product → Card → Pack; the card then auto-tracks its grade's live value daily; customers see it converted to MYR and marked up 20%, while internal money math stays on raw USD.

**Architecture:** A custom file-based admin page creates a Medusa **Product** with the PriceCharting id in `product.metadata`. Registering that product as a **Card** (existing flow, enriched) copies the link onto the Card. A daily job refreshes each linked card's raw USD `market_value` + a cached USD→MYR rate. Customer price is computed on read as `market_value × fx × multiplier`; `market_value` stays raw so buyback/RTP are unaffected.

**Tech Stack:** Medusa v2 / Mercur backend (`backend/packages/api`, TypeScript, jest), Vite + React + React Query + `@medusajs/ui` admin (`backend/apps/admin`, `@mercurjs/admin` 2.1.6, file-based routes only — no widget/injection system), Next.js storefront (`src/`). Package managers: `npm` at root, `corepack yarn` in `backend/`.

## Global Constraints

- **Entry point is a custom file-based admin page** — the stock `/dashboard/products/create` cannot host injected UI (Medusa has no create-page zone; this Mercur build wires no widget system). Do NOT fork the stock create page.
- **PriceCharting link anchored on the Product** (`product.metadata.pc_product_id / pc_grade / market_multiplier`), **copied onto the Card** at registration. Card keeps its own copies (the daily job reads them).
- **Currency:** `Card.market_value` = raw USD (bigNumber). Display MYR = `market_value × fx × multiplier`. FX + markup are display-only, never written to `market_value`.
- **Default multiplier:** `1.20`, per-card, editable; prefilled on create & edit.
- **Refresh:** daily job only. PriceCharting API limit **1 request/second** — throttle.
- **Guardrails:** null/zero/error from PC or FX → keep last-known; never zero a price; never crash the batch; log every change.
- **Secret:** `PRICECHARTING_API_TOKEN` server-side only; never committed.
- **Handles:** one card = one grade; product `handle` = `slug(name-grader-grade)` (unique per grade).
- **Money-path rule:** run `corepack yarn test:integration:http` (from `backend/packages/api`), not just unit.
- **Verification:** repo Stop hook type-checks storefront + backend. UI verified with Playwright/manual capture, not brittle unit assertions (repo `testing.md`).

---

## File Structure

**Backend — new**
- `src/modules/packs/pricecharting-grades.ts` — grade-label ⇄ price-field map + `priceFieldForGrade()` + `gradeToGrader()`.
- `src/modules/packs/pricing.ts` — `displayMarketPrice()`, `effectiveRate()`, `resolveFxRate()`, `fetchUsdMyr()`, `DEFAULT_USD_MYR`.
- `src/modules/packs/models/fx-rate.ts` — `FxRate` model.
- `src/workflows/create-product-from-pricecharting.ts` — creates a Product (metadata carries the PC link). No card.
- `src/api/admin/products/from-pricecharting/route.ts` — `POST` create-product endpoint.
- `src/api/admin/pricing/fx/route.ts` — `GET`/`POST` admin FX rate.
- `src/jobs/sync-market-prices.ts` + `src/modules/packs/sync-market-prices.ts` — daily job + testable core.
- Tests under `src/**/__tests__/` and `integration-tests/{modules,http}/`.

**Backend — modified**
- `src/modules/packs/models/card.ts` — add `pc_product_id`, `pc_grade`, `market_multiplier`, `pc_synced_at`.
- `src/modules/packs/index.ts` + `service.ts` — register `FxRate`.
- `src/api/admin/pricecharting/product/route.ts` — import `PRICE_FIELDS` from the shared module.
- `src/workflows/steps/create-card.ts` — **copy `pc_*` fields from `product.metadata`** onto the Card.
- `src/workflows/steps/update-card.ts` — accept/write `pc_*` fields (editable).
- `src/api/admin/cards/route.ts` + `[handle]/route.ts` — accept/return `pc_*` + admin price breakdown.
- `src/api/store/vault/route.ts`, `src/api/store/pulls/recent/route.ts`, `src/api/store/pulls/[id]/reveal/route.ts` — add `marketPriceMyr`.

**Admin UI — new**
- `src/routes/products/from-pricecharting/page.tsx` — the "Add from PriceCharting" page (+ menu item).

**Admin UI — modified**
- `src/lib/admin-rest.ts`, `queries.ts`, `query-keys.ts` — `createProductFromPriceCharting`, FX helpers, Card DTO + breakdown.
- `src/routes/cards/page.tsx` (+ `RegisterCardModal.tsx`) — linked/synced indicator + markup on cards that carry a link.

**Storefront — modified**
- `src/lib/actions/vault.ts` + `src/app/(account)/vault/VaultClient.tsx` — render `marketPriceMyr`.
- pull-reveal component(s) — render `marketPriceMyr`.

---

## Phase 1 — Pricing core (backend, no UI)

### Task 1: Shared grade ⇄ price-field mapping

**Files:** Create `src/modules/packs/pricecharting-grades.ts`; Modify `src/api/admin/pricecharting/product/route.ts`; Test `src/modules/packs/__tests__/pricecharting-grades.test.ts`.

**Interfaces:** Produces `PRICE_FIELDS`, `type PcPriceField`, `priceFieldForGrade(label): PcPriceField|null`, `gradeToGrader(label): {grader,grade}`.

- [ ] **Step 1: Failing test**
```ts
import { priceFieldForGrade, gradeToGrader, PRICE_FIELDS } from "../pricecharting-grades";
test("maps labels to fields", () => {
  expect(priceFieldForGrade("PSA 10")).toBe("manual-only-price");
  expect(priceFieldForGrade("BGS 10")).toBe("bgs-10-price");
  expect(priceFieldForGrade("Ungraded")).toBe("loose-price");
  expect(priceFieldForGrade("nope")).toBeNull();
});
test("splits graded tiers, blanks generic grader", () => {
  expect(gradeToGrader("PSA 10")).toEqual({ grader: "PSA", grade: "10" });
  expect(gradeToGrader("Grade 9.5")).toEqual({ grader: "", grade: "9.5" });
  expect(gradeToGrader("Ungraded")).toEqual({ grader: "", grade: "Ungraded" });
});
test("nine tiers ascending", () => {
  expect(PRICE_FIELDS.map(([, l]) => l)).toEqual([
    "Ungraded","Grade 7","Grade 8","Grade 9","Grade 9.5","PSA 10","BGS 10","CGC 10","SGC 10"]);
});
```
- [ ] **Step 2: Run → fails.** `corepack yarn test:unit pricecharting-grades` → module not found.
- [ ] **Step 3: Implement**
```ts
// pricecharting-grades.ts
export const PRICE_FIELDS = [
  ["loose-price","Ungraded"],["cib-price","Grade 7"],["new-price","Grade 8"],
  ["graded-price","Grade 9"],["box-only-price","Grade 9.5"],["manual-only-price","PSA 10"],
  ["bgs-10-price","BGS 10"],["condition-17-price","CGC 10"],["condition-18-price","SGC 10"],
] as const;
export type PcPriceField = (typeof PRICE_FIELDS)[number][0];
export function priceFieldForGrade(label: string): PcPriceField | null {
  const hit = PRICE_FIELDS.find(([, l]) => l === label);
  return hit ? hit[0] : null;
}
export function gradeToGrader(label: string): { grader: string; grade: string } {
  for (const g of ["PSA","BGS","CGC","SGC"]) {
    if (label.startsWith(g + " ")) return { grader: g, grade: label.slice(g.length + 1) };
  }
  if (label.startsWith("Grade ")) return { grader: "", grade: label.slice(6) };
  return { grader: "", grade: label };
}
```
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Refactor route.** In `product/route.ts`, delete the local `PRICE_FIELDS` and `import { PRICE_FIELDS } from "../../../../modules/packs/pricecharting-grades";`.
- [ ] **Step 6: `corepack yarn tsc --noEmit` clean; commit.**
```bash
git add backend/packages/api/src/modules/packs/pricecharting-grades.ts backend/packages/api/src/modules/packs/__tests__/pricecharting-grades.test.ts backend/packages/api/src/api/admin/pricecharting/product/route.ts
git commit -m "feat(pricing): extract shared PriceCharting grade mapping"
```

### Task 2: Display-price + FX helpers

**Files:** Create `src/modules/packs/pricing.ts`; Test `src/modules/packs/__tests__/pricing.test.ts`.

**Interfaces:** Produces `DEFAULT_USD_MYR`, `displayMarketPrice(raw,fx,mult): number`, `effectiveRate(row|null): number`, `fetchUsdMyr(url?): Promise<number>`, `FX_USD_MYR_URL`, and (added in Task 7) `resolveFxRate(packs): Promise<number>`.

- [ ] **Step 1: Failing test**
```ts
import { displayMarketPrice, effectiveRate, DEFAULT_USD_MYR } from "../pricing";
test("raw×fx×mult rounded", () => {
  expect(displayMarketPrice(100,4.7,1.2)).toBe(564);
  expect(displayMarketPrice(19.99,4.5,1.2)).toBe(107.95);
});
test("invalid → 0", () => {
  expect(displayMarketPrice(-1,4.7,1.2)).toBe(0);
  expect(displayMarketPrice(100,0,1.2)).toBe(0);
  expect(displayMarketPrice(NaN,4.7,1.2)).toBe(0);
});
test("effectiveRate override/fallback", () => {
  expect(effectiveRate({rate:4.5,manual_override:true,manual_rate:4.8})).toBe(4.8);
  expect(effectiveRate({rate:4.5,manual_override:false,manual_rate:null})).toBe(4.5);
  expect(effectiveRate({rate:0,manual_override:false,manual_rate:null})).toBe(DEFAULT_USD_MYR);
  expect(effectiveRate(null)).toBe(DEFAULT_USD_MYR);
});
```
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement**
```ts
// pricing.ts
export const DEFAULT_USD_MYR = 4.7;
export const FX_USD_MYR_URL = process.env.FX_USD_MYR_URL ?? "https://api.frankfurter.app/latest?from=USD&to=MYR";
export function displayMarketPrice(marketValueUsd: number, fxUsdMyr: number, multiplier: number): number {
  const raw = Number(marketValueUsd), fx = Number(fxUsdMyr), mult = Number(multiplier);
  if (![raw,fx,mult].every(Number.isFinite) || raw < 0 || fx <= 0 || mult <= 0) return 0;
  return Math.round(raw * fx * mult * 100) / 100;
}
export function effectiveRate(row: { rate: number; manual_override: boolean; manual_rate: number | null } | null): number {
  if (!row) return DEFAULT_USD_MYR;
  if (row.manual_override) { const m = Number(row.manual_rate); if (Number.isFinite(m) && m > 0) return m; }
  const r = Number(row.rate); return Number.isFinite(r) && r > 0 ? r : DEFAULT_USD_MYR;
}
export async function fetchUsdMyr(url: string = FX_USD_MYR_URL): Promise<number> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data = (await resp.json()) as { rates?: { MYR?: number } };
  const rate = data?.rates?.MYR;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) throw new Error("FX feed: no usable USD->MYR");
  return rate;
}
```
- [ ] **Step 4: Run → passes. Commit.**
```bash
git add backend/packages/api/src/modules/packs/pricing.ts backend/packages/api/src/modules/packs/__tests__/pricing.test.ts
git commit -m "feat(pricing): display-price + FX resolution helpers"
```

### Task 3: `Card` fields + `FxRate` model + migration

**Files:** Modify `src/modules/packs/models/card.ts`, `index.ts`, `service.ts`; Create `src/modules/packs/models/fx-rate.ts`; Migration under `src/modules/packs/migrations/`; Test `integration-tests/modules/card-fields.spec.ts`.

**Interfaces:** Produces `Card.{pc_product_id,pc_grade,market_multiplier,pc_synced_at}` + `FxRate`.

- [ ] **Step 1: Add Card fields** (after `sprite_image` in `card.ts`):
```ts
  pc_product_id: model.text().nullable(),
  pc_grade: model.text().nullable(),
  market_multiplier: model.bigNumber().default(1.2),
  pc_synced_at: model.dateTime().nullable(),
```
- [ ] **Step 2: Create `fx-rate.ts`**
```ts
import { model } from "@medusajs/framework/utils";
export const FxRate = model.define("fx_rate", {
  id: model.id().primaryKey(),
  pair: model.text().unique(),
  rate: model.bigNumber(),
  source: model.text(),
  fetched_at: model.dateTime().nullable(),
  manual_override: model.boolean().default(false),
  manual_rate: model.bigNumber().nullable(),
});
export default FxRate;
```
- [ ] **Step 3: Register `FxRate`** in `src/modules/packs/index.ts` (module models list) and `service.ts` (`MedusaService({...})`), matching the existing `Card` registration style so `listFxRates`/`createFxRates`/`updateFxRates` are generated.
- [ ] **Step 4: Generate migration.** From `backend/packages/api`: `corepack yarn medusa db:generate packs` (use the module's registered key from `medusa-config.ts` if different). Confirm a file lands in `migrations/`.
- [ ] **Step 5: Module test** `card-fields.spec.ts`
```ts
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
medusaIntegrationTestRunner({ testSuite: ({ getContainer }) => {
  it("persists pc fields + default multiplier", async () => {
    const packs = getContainer().resolve(PACKS_MODULE);
    const [c] = await packs.createCards([{ handle:"charizard-psa-10", name:"Charizard", set:"Base Set",
      grader:"PSA", grade:"10", market_value:100, image:"https://x/y.png", pc_product_id:"6910", pc_grade:"PSA 10" }]);
    expect(c.pc_product_id).toBe("6910"); expect(c.pc_grade).toBe("PSA 10");
    expect(Number(c.market_multiplier)).toBe(1.2); expect(c.pc_synced_at).toBeNull();
  });
}});
```
- [ ] **Step 6:** `corepack yarn medusa db:migrate` then `corepack yarn test:integration:modules card-fields` → PASS.
- [ ] **Step 7: Commit**
```bash
git add backend/packages/api/src/modules/packs/models/card.ts backend/packages/api/src/modules/packs/models/fx-rate.ts backend/packages/api/src/modules/packs/index.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/modules/packs/migrations/ backend/packages/api/integration-tests/modules/card-fields.spec.ts
git commit -m "feat(pricing): add PC linkage fields + FxRate model + migration"
```

---

## Phase 2 — Product-from-PriceCharting + carry link + expose price

### Task 4: Product-create-from-PriceCharting workflow + route

**Files:** Create `src/workflows/create-product-from-pricecharting.ts`, `src/api/admin/products/from-pricecharting/route.ts`; Test `integration-tests/http/product-from-pc.spec.ts`.

**Interfaces:** Produces `POST /admin/products/from-pricecharting` body `{ pc_product_id, pc_grade, name, set, grader, grade, market_value, image, price?, for_sale?, market_multiplier? }` → `{ product: { id, handle } }`. Creates a Product with `metadata.{fmv,grade,grader,set,pc_product_id,pc_grade,market_multiplier}`. **No card.**

- [ ] **Step 1: Workflow**
```ts
// create-product-from-pricecharting.ts
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { createProductsWorkflow } from "@medusajs/medusa/core-flows";

export type CreateProductFromPcInput = {
  pc_product_id: string; pc_grade: string;
  name: string; set: string; grader: string; grade: string;
  market_value: number; image: string;
  price?: number | null; for_sale?: boolean; market_multiplier?: number;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const createProductFromPriceChartingWorkflow = createWorkflow(
  "create-product-from-pricecharting",
  (input: CreateProductFromPcInput) => {
    const result = createProductsWorkflow.runAsStep({
      input: { products: [{
        title: input.name,
        handle: slug(`${input.name}-${input.grader}-${input.grade}`),
        status: input.for_sale === false ? "draft" : "published",
        thumbnail: input.image,
        images: [{ url: input.image }],
        options: [{ title: "Default", values: ["Default"] }],
        variants: [{ title: "Default", options: { Default: "Default" },
          prices: [{ amount: Math.round((input.price ?? input.market_value) * 100), currency_code: "myr" }] }],
        metadata: {
          fmv: input.market_value, grade: input.grade, grader: input.grader, set: input.set,
          pc_product_id: input.pc_product_id, pc_grade: input.pc_grade,
          market_multiplier: input.market_multiplier ?? 1.2,
        },
      }] },
    });
    return new WorkflowResponse(result);
  }
);
```
- [ ] **Step 2: Route**
```ts
// api/admin/products/from-pricecharting/route.ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { createProductFromPriceChartingWorkflow } from "../../../../workflows/create-product-from-pricecharting";
const Body = z.object({
  pc_product_id: z.string().min(1), pc_grade: z.string().min(1),
  name: z.string().min(1), set: z.string().default(""), grader: z.string().default(""), grade: z.string().default(""),
  market_value: z.coerce.number().nonnegative(), image: z.string().url(),
  price: z.coerce.number().nonnegative().nullable().optional(), for_sale: z.boolean().optional(),
  market_multiplier: z.coerce.number().positive().default(1.2),
});
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid body" }); return; }
  const { result } = await createProductFromPriceChartingWorkflow(req.scope).run({ input: parsed.data });
  const product = Array.isArray(result) ? result[0] : result;
  res.status(201).json({ product: { id: product.id, handle: product.handle } });
}
```
- [ ] **Step 3: HTTP test** `product-from-pc.spec.ts`
```ts
it("creates a product with the PC link on metadata (no card)", async () => {
  const { data } = await api.post("/admin/products/from-pricecharting", {
    pc_product_id:"6910", pc_grade:"PSA 10", name:"Charizard", set:"Base Set", grader:"PSA", grade:"10",
    market_value:100, image:"https://example.com/charizard.png", market_multiplier:1.2 }, adminHeaders);
  expect(data.product.handle).toBe("charizard-psa-10");
  const prod = await api.get(`/admin/products/${data.product.id}?fields=+metadata`, adminHeaders);
  expect(prod.data.product.metadata.pc_product_id).toBe("6910");
  expect(prod.data.product.metadata.pc_grade).toBe("PSA 10");
});
```
- [ ] **Step 4: Run → PASS. Commit.**
```bash
git add backend/packages/api/src/workflows/create-product-from-pricecharting.ts backend/packages/api/src/api/admin/products/from-pricecharting/route.ts backend/packages/api/integration-tests/http/product-from-pc.spec.ts
git commit -m "feat(pricing): create product from PriceCharting (link on metadata)"
```

### Task 5: Carry the link Product → Card (+ editable on update)

**Files:** Modify `src/workflows/steps/create-card.ts`, `src/workflows/steps/update-card.ts`, `src/api/admin/cards/route.ts`, `src/api/admin/cards/[handle]/route.ts`; Test `integration-tests/http/card-inherits-pc.spec.ts`.

**Interfaces:** Consumes `product.metadata` from Task 4. `createCardStep` now writes `pc_product_id`/`pc_grade`/`market_multiplier` onto the Card, read from the product (input overrides if provided). `updateCardStep` input gains the same optional fields.

- [ ] **Step 1: Enrich `create-card.ts`** — add optional `pc_product_id?`, `pc_grade?`, `market_multiplier?` to `RegisterCardInput`; after the product is loaded, derive from metadata:
```ts
const meta = (product.metadata ?? {}) as Record<string, unknown>;
const pcProductId = input.pc_product_id ?? (typeof meta.pc_product_id === "string" ? meta.pc_product_id : null);
const pcGrade = input.pc_grade ?? (typeof meta.pc_grade === "string" ? meta.pc_grade : null);
const mult = input.market_multiplier ?? (Number.isFinite(Number(meta.market_multiplier)) ? Number(meta.market_multiplier) : 1.2);
```
and add to the `packs.createCards([{ ... }])` object:
```ts
      pc_product_id: pcProductId,
      pc_grade: pcGrade,
      market_multiplier: mult,
```
- [ ] **Step 2: Enrich `update-card.ts`** — add optional `pc_product_id?`, `pc_grade?`, `market_multiplier?` to its input; in `packs.updateCards([{ ... }])` add:
```ts
      pc_product_id: input.pc_product_id ?? null,
      pc_grade: input.pc_grade ?? null,
      market_multiplier: input.market_multiplier ?? 1.2,
```
- [ ] **Step 3: Admin cards routes** — in `cards/route.ts` (POST) accept optional `market_multiplier` (default 1.2) into the register input; in `cards/[handle]/route.ts` (POST) accept `pc_product_id`(nullable, for unlink)/`pc_grade`/`market_multiplier`; GET returns `pc_product_id`, `pc_grade`, `market_multiplier`, `pc_synced_at`. Match existing schema/response style.
- [ ] **Step 4: HTTP test** `card-inherits-pc.spec.ts`
```ts
it("card registered from a PC product inherits the link", async () => {
  const { data: p } = await api.post("/admin/products/from-pricecharting", {
    pc_product_id:"6910", pc_grade:"PSA 10", name:"Charizard", set:"Base Set", grader:"PSA", grade:"10",
    market_value:100, image:"https://example.com/charizard.png" }, adminHeaders);
  await api.post("/admin/cards", { product_id: p.product.id, set:"Base Set", grader:"PSA", grade:"10", market_value:100 }, adminHeaders);
  const { data } = await api.get(`/admin/cards/${p.product.handle}`, adminHeaders);
  expect(data.card.pc_product_id).toBe("6910");
  expect(data.card.pc_grade).toBe("PSA 10");
});
```
- [ ] **Step 5: Run → PASS. Commit.**
```bash
git add backend/packages/api/src/workflows/steps/create-card.ts backend/packages/api/src/workflows/steps/update-card.ts backend/packages/api/src/api/admin/cards/route.ts backend/packages/api/src/api/admin/cards/[handle]/route.ts backend/packages/api/integration-tests/http/card-inherits-pc.spec.ts
git commit -m "feat(pricing): carry PriceCharting link from product onto card"
```

### Task 6: Admin FX rate endpoint

**Files:** Create `src/api/admin/pricing/fx/route.ts`; Test `integration-tests/http/fx-rate.spec.ts`.

**Interfaces:** Consumes `FxRate` (Task 3), `effectiveRate` (Task 2). `GET /admin/pricing/fx` → `{ rate, source, fetched_at, manual_override, manual_rate, effective }`. `POST` body `{ manual_override, manual_rate? }` upserts the `USD_MYR` row.

- [ ] **Step 1: Route**
```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { PACKS_MODULE } from "../../../../modules/packs";
import { effectiveRate, DEFAULT_USD_MYR } from "../../../../modules/packs/pricing";
async function loadRow(scope: MedusaRequest["scope"]) {
  const packs: any = scope.resolve(PACKS_MODULE);
  const [row] = await packs.listFxRates({ pair: "USD_MYR" }, { take: 1 });
  return { packs, row };
}
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { row } = await loadRow(req.scope);
  res.json({ rate: row ? Number(row.rate) : DEFAULT_USD_MYR, source: row?.source ?? "fallback",
    fetched_at: row?.fetched_at ?? null, manual_override: row?.manual_override ?? false,
    manual_rate: row?.manual_rate != null ? Number(row.manual_rate) : null, effective: effectiveRate(row ?? null) });
}
const Body = z.object({ manual_override: z.boolean(), manual_rate: z.coerce.number().positive().nullable().optional() });
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: "Invalid body" }); return; }
  const { packs, row } = await loadRow(req.scope);
  if (row) await packs.updateFxRates([{ id: row.id, manual_override: parsed.data.manual_override, manual_rate: parsed.data.manual_rate ?? null }]);
  else await packs.createFxRates([{ pair:"USD_MYR", rate: DEFAULT_USD_MYR, source:"manual", manual_override: parsed.data.manual_override, manual_rate: parsed.data.manual_rate ?? null }]);
  const after = await loadRow(req.scope);
  res.json({ effective: effectiveRate(after.row ?? null) });
}
```
- [ ] **Step 2: Test**
```ts
it("fallback then manual override", async () => {
  expect((await api.get("/admin/pricing/fx", adminHeaders)).data.effective).toBeGreaterThan(0);
  await api.post("/admin/pricing/fx", { manual_override:true, manual_rate:4.85 }, adminHeaders);
  expect((await api.get("/admin/pricing/fx", adminHeaders)).data.effective).toBe(4.85);
});
```
- [ ] **Step 3: Run → PASS. Commit.**
```bash
git add backend/packages/api/src/api/admin/pricing/fx/route.ts backend/packages/api/integration-tests/http/fx-rate.spec.ts
git commit -m "feat(pricing): admin FX rate endpoint with manual override"
```

### Task 7: Expose computed market price in reads

**Files:** Modify `src/modules/packs/pricing.ts` (add `resolveFxRate`), `src/api/store/vault/route.ts`, `src/api/store/pulls/recent/route.ts`, `src/api/store/pulls/[id]/reveal/route.ts`, `src/api/admin/cards/route.ts` + `[handle]/route.ts`; Test `integration-tests/http/vault-market-price.spec.ts`.

**Interfaces:** Store card payloads gain `marketPriceMyr: number`; admin card payloads gain `{ raw, fxRate, marketMyr, displayPrice, markup }`.

- [ ] **Step 1: Add `resolveFxRate`** to `pricing.ts`:
```ts
export async function resolveFxRate(packs: { listFxRates: (f: unknown, c: unknown) => Promise<Array<{ rate:number; manual_override:boolean; manual_rate:number|null }>> }): Promise<number> {
  const [row] = await packs.listFxRates({ pair: "USD_MYR" }, { take: 1 });
  return effectiveRate(row ?? null);
}
```
- [ ] **Step 2: Store routes** — in `store/vault/route.ts`, `pulls/recent/route.ts`, `pulls/[id]/reveal/route.ts`, resolve the rate once and add per card:
```ts
import { resolveFxRate, displayMarketPrice } from "../../../modules/packs/pricing";
const packs: any = req.scope.resolve(PACKS_MODULE);
const fxRate = await resolveFxRate(packs);
// per card: marketPriceMyr: displayMarketPrice(Number(card.market_value), fxRate, Number(card.market_multiplier ?? 1.2)),
```
- [ ] **Step 3: Admin card breakdown** — in `admin/cards/route.ts` + `[handle]/route.ts`, resolve `fxRate` once, attach per card: `raw = Number(card.market_value)`, `mult = Number(card.market_multiplier ?? 1.2)`, `marketMyr = displayMarketPrice(raw,fxRate,1)`, `displayPrice = displayMarketPrice(raw,fxRate,mult)`, `markup = Math.round((displayPrice - marketMyr)*100)/100`.
- [ ] **Step 4: HTTP test**
```ts
it("vault item exposes marketPriceMyr = raw×fx×mult", async () => {
  await api.post("/admin/pricing/fx", { manual_override:true, manual_rate:4.0 }, adminHeaders);
  // seed a pull of a card market_value=100, multiplier=1.2 via existing helpers
  const { data } = await api.get("/store/vault", customerHeaders);
  const item = data.items.find((i:any) => i.card.handle === seededHandle);
  expect(item.card.marketPriceMyr).toBe(480);
});
```
- [ ] **Step 5: Run → PASS. Commit.**
```bash
git add backend/packages/api/src/modules/packs/pricing.ts backend/packages/api/src/api/store/vault/route.ts backend/packages/api/src/api/store/pulls/recent/route.ts backend/packages/api/src/api/store/pulls/[id]/reveal/route.ts backend/packages/api/src/api/admin/cards/route.ts backend/packages/api/src/api/admin/cards/[handle]/route.ts backend/packages/api/integration-tests/http/vault-market-price.spec.ts
git commit -m "feat(pricing): expose computed MYR market price in store + admin reads"
```

---

## Phase 3 — Daily sync job

### Task 8: `sync-market-prices` job

**Files:** Create `src/jobs/sync-market-prices.ts`, `src/modules/packs/sync-market-prices.ts`; Test `src/modules/packs/__tests__/sync-market-prices.test.ts`.

**Interfaces:** Consumes `pcFetch` (`src/api/admin/pricecharting/client.ts`), `priceFieldForGrade` (Task 1), `fetchUsdMyr` (Task 2). Produces `refreshCardPrice(card, deps)` + the scheduled `default` job.

- [ ] **Step 1: Failing test**
```ts
import { refreshCardPrice } from "../sync-market-prices";
const card = { id:"c1", handle:"charizard-psa-10", pc_product_id:"6910", pc_grade:"PSA 10", market_value:100 };
test("updates from tier price", async () => {
  const upd:any[]=[]; const r = await refreshCardPrice(card as any, {
    pcFetch: async () => ({ kind:"ok", data:{ "manual-only-price":15000 } }),
    updateCards: async (u:any)=>{upd.push(u[0]);}, now:new Date("2026-07-01T00:00:00Z") });
  expect(r.newValue).toBe(150); expect(r.changed).toBe(true); expect(upd[0].market_value).toBe(150);
});
test("keeps last-known on error", async () => {
  const r = await refreshCardPrice(card as any, { pcFetch: async () => ({ kind:"error", message:"boom" }),
    updateCards: async ()=>{throw new Error("no write");}, now:new Date("2026-07-01T00:00:00Z") });
  expect(r.changed).toBe(false); expect(r.skippedReason).toBe("boom");
});
test("skips zero price", async () => {
  const r = await refreshCardPrice(card as any, { pcFetch: async () => ({ kind:"ok", data:{ "manual-only-price":0 } }),
    updateCards: async ()=>{throw new Error("no write");}, now:new Date("2026-07-01T00:00:00Z") });
  expect(r.changed).toBe(false); expect(r.skippedReason).toMatch(/no usable price/i);
});
```
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement core**
```ts
// modules/packs/sync-market-prices.ts
import { priceFieldForGrade } from "./pricecharting-grades";
type PcRes = { kind:"ok"; data: Record<string, unknown> } | { kind:"no-token" } | { kind:"error"; message:string };
export type RefreshDeps = {
  pcFetch: (path: string, params: Record<string,string>) => Promise<PcRes>;
  updateCards: (u: Array<{ id:string; market_value:number; pc_synced_at:Date }>) => Promise<unknown>;
  now: Date;
};
export type CardRow = { id:string; handle:string; pc_product_id:string|null; pc_grade:string|null; market_value:number };
export async function refreshCardPrice(card: CardRow, deps: RefreshDeps) {
  const oldValue = Number(card.market_value);
  const base = { handle: card.handle, oldValue, newValue: oldValue, changed: false as boolean };
  if (!card.pc_product_id || !card.pc_grade) return { ...base, skippedReason: "not linked" };
  const field = priceFieldForGrade(card.pc_grade);
  if (!field) return { ...base, skippedReason: `unknown grade '${card.pc_grade}'` };
  const res = await deps.pcFetch("/api/product", { id: card.pc_product_id });
  if (res.kind !== "ok") return { ...base, skippedReason: res.kind === "no-token" ? "no token" : res.message };
  const pennies = res.data[field];
  if (typeof pennies !== "number" || !Number.isFinite(pennies) || pennies <= 0) return { ...base, skippedReason: "no usable price" };
  const newValue = Math.round(pennies) / 100;
  await deps.updateCards([{ id: card.id, market_value: newValue, pc_synced_at: deps.now }]);
  return { handle: card.handle, oldValue, newValue, changed: newValue !== oldValue };
}
```
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Job wrapper**
```ts
// jobs/sync-market-prices.ts
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../modules/packs";
import { pcFetch } from "../api/admin/pricecharting/client";
import { fetchUsdMyr } from "../modules/packs/pricing";
import { refreshCardPrice } from "../modules/packs/sync-market-prices";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export default async function syncMarketPricesJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs: any = container.resolve(PACKS_MODULE);
  const now = new Date();
  try {
    const rate = await fetchUsdMyr();
    const [row] = await packs.listFxRates({ pair:"USD_MYR" }, { take:1 });
    if (row) await packs.updateFxRates([{ id: row.id, rate, source:"frankfurter", fetched_at: now }]);
    else await packs.createFxRates([{ pair:"USD_MYR", rate, source:"frankfurter", fetched_at: now }]);
    logger.info(`[sync-market-prices] FX USD->MYR = ${rate}`);
  } catch (e) { logger.warn(`[sync-market-prices] FX failed, keeping last-known: ${(e as Error).message}`); }
  const cards = await packs.listCards({ pc_product_id: { $ne: null } }, { take: 10000 });
  let changed = 0;
  for (const card of cards) {
    const r = await refreshCardPrice(card, { pcFetch, updateCards: (u) => packs.updateCards(u), now });
    if (r.changed) { changed++; logger.info(`[sync-market-prices] ${r.handle} ${r.oldValue} -> ${r.newValue}`); }
    else if (r.skippedReason) logger.warn(`[sync-market-prices] skip ${r.handle}: ${r.skippedReason}`);
    await sleep(1100);
  }
  logger.info(`[sync-market-prices] done: ${changed}/${cards.length} updated`);
}
export const config = { name: "sync-market-prices", schedule: "0 3 * * *" };
```
- [ ] **Step 6:** `corepack yarn tsc --noEmit` clean. (If the service rejects `{ $ne: null }`, list all cards and `.filter(c => c.pc_product_id)` in JS.) Commit.
```bash
git add backend/packages/api/src/jobs/sync-market-prices.ts backend/packages/api/src/modules/packs/sync-market-prices.ts backend/packages/api/src/modules/packs/__tests__/sync-market-prices.test.ts
git commit -m "feat(pricing): daily PriceCharting + FX sync job"
```

---

## Phase 4 — Admin UI

> Verify with the admin running + Playwright/manual capture (repo `testing.md`), not brittle unit assertions.

### Task 9: Admin REST + query wiring

**Files:** Modify `src/lib/admin-rest.ts`, `queries.ts`, `query-keys.ts`.

- [ ] **Step 1: DTO + helpers in `admin-rest.ts`** — add `pc_product_id`, `pc_grade`, `market_multiplier`, `pc_synced_at` + breakdown (`raw`, `fxRate`, `marketMyr`, `displayPrice`, `markup`) to the Card type; add:
```ts
export async function createProductFromPriceCharting(body: {
  pc_product_id:string; pc_grade:string; name:string; set:string; grader:string; grade:string;
  market_value:number; image:string; price?:number|null; for_sale?:boolean; market_multiplier?:number;
}): Promise<{ id:string; handle:string }> {
  const res = await fetch(`${__BACKEND_URL__}/admin/products/from-pricecharting`, {
    method:"POST", credentials:"include", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json()).message ?? "Create failed");
  return (await res.json()).product;
}
export async function getFxRate(): Promise<{ effective:number; manual_override:boolean; manual_rate:number|null; fetched_at:string|null }> {
  return (await fetch(`${__BACKEND_URL__}/admin/pricing/fx`, { credentials:"include" })).json();
}
export async function setFxRate(body: { manual_override:boolean; manual_rate?:number|null }): Promise<void> {
  await fetch(`${__BACKEND_URL__}/admin/pricing/fx`, { method:"POST", credentials:"include", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
}
```
- [ ] **Step 2: Hooks + keys** — `query-keys.ts`: `fxRate: ["admin","pricing","fx"] as const`. `queries.ts`: `useFxRate()`, `useSetFxRate()` (invalidate fxRate + cards), `useCreateProductFromPriceCharting()` (invalidate cards + eligible products). Match existing style.
- [ ] **Step 3:** admin `tsc --noEmit` clean; commit.
```bash
git add backend/apps/admin/src/lib/admin-rest.ts backend/apps/admin/src/lib/queries.ts backend/apps/admin/src/lib/query-keys.ts
git commit -m "feat(pricing): admin REST + query wiring for PC product create + FX"
```

### Task 10: New "Add from PriceCharting" admin page

**Files:** Create `src/routes/products/from-pricecharting/page.tsx` (+ its `RouteConfig` menu entry).

- [ ] **Step 1: Page skeleton + route config** — a file-based route exporting `RouteConfig` (label "Add from PriceCharting", a suitable icon, nested near Products) rendering a `Container` with a heading. Follow `dashboard-page-ui` + `medusa-ui-conformance`.
- [ ] **Step 2: PriceCharting search + grade picker** — reuse `searchPriceCharting`/`getPriceChartingProduct` (already in `admin-rest.ts`): text query → match list → on pick, load per-grade prices → grade-tier picker. Picking a tier sets `market_value` = that USD, derives grader/grade (client mirror of `gradeToGrader`), and records `pc_product_id` + `pc_grade` (the tier label).
- [ ] **Step 3: Markup + live preview** — `market_multiplier` field (percent input, default 20%). Preview row via `useFxRate()`: `Raw $X · FX {effective} · Market RM{raw×fx} · Customer sees RM{raw×fx×mult} · Margin RM{raw×fx×(mult−1)}`.
- [ ] **Step 4: Image (auto-pull + upload)** — attempt a best-effort image prefill (see Task 15; if the endpoint isn't available yet, skip prefill) and always offer `useUploadImage()` upload/replace. The final image URL is required before submit.
- [ ] **Step 5: "Add product"** — submit via `useCreateProductFromPriceCharting()`; on success toast + show the new product handle/link. Preserve loading/error/empty states.
- [ ] **Step 6: Verify running** — backend :9000 + admin; open the page, search, pick a grade, confirm value/grader/grade fill + preview math, upload an image, click "Add product", confirm the product appears in the Products list with `metadata.pc_product_id`. Screenshot to `docs/research/`.
- [ ] **Step 7: Commit**
```bash
git add "backend/apps/admin/src/routes/products/from-pricecharting/page.tsx"
git commit -m "feat(pricing): Add-from-PriceCharting admin page"
```

### Task 11: Card linked/synced indicator + markup

**Files:** Modify `src/routes/cards/page.tsx` (edit form) and/or `RegisterCardModal.tsx`.

- [ ] **Step 1: Indicator + markup on edit** — in the card edit form, when `card.pc_product_id` is set show `🔗 Linked · synced {pc_synced_at}` and the `market_multiplier` (percent, editable, passed to `updateCard`). Add an "Unlink" action that submits `pc_product_id: null` (reverts to manual pricing).
- [ ] **Step 2: Verify + commit** — open a linked card's edit form, confirm the indicator + markup show and unlink works. Screenshot to `docs/research/`.
```bash
git add "backend/apps/admin/src/routes/cards/page.tsx" backend/apps/admin/src/routes/cards/RegisterCardModal.tsx
git commit -m "feat(pricing): card linked/synced indicator + editable markup"
```

---

## Phase 5 — Storefront display

### Task 12: Vault shows live MYR market price

**Files:** Modify `src/lib/actions/vault.ts`, `src/app/(account)/vault/VaultClient.tsx`.

- [ ] **Step 1:** In `vault.ts`, add `marketPriceMyr: number` to the `card` shape of `VaultItem` and map it from the `/store/vault` response (Task 7 returns it).
- [ ] **Step 2:** In `VaultClient.tsx` (~line 321-328), change `{rm(item.card.marketValue)}` → `{rm(item.card.marketPriceMyr)}`.
- [ ] **Step 3: Verify** — `npm run build` + `pwsh scripts/serve-standalone.ps1 -Port 4000`, backend up; log in as test customer, open vault, confirm each card shows `raw × fx × 1.2`. Screenshot to `docs/research/`.
- [ ] **Step 4: Commit**
```bash
git add src/lib/actions/vault.ts "src/app/(account)/vault/VaultClient.tsx"
git commit -m "feat(pricing): vault shows live MYR market price"
```

### Task 13: Pull-reveal shows the market price

**Files:** Modify the pull-reveal component that renders a freshly pulled card (locate via the `/store/pulls/[id]/reveal` or `recent` consumer in `src/`) + its type.

- [ ] **Step 1:** Thread `marketPriceMyr` (Task 7 returns it) into the reveal component's card type and render it via `rm()`, same as the vault.
- [ ] **Step 2: Verify + commit** — open a pack, confirm the revealed card shows the marked-up MYR price. Screenshot to `docs/research/`.
```bash
git add <reveal component + type>
git commit -m "feat(pricing): pull-reveal shows live MYR market price"
```

### Task 14: Marketplace listing (dormant behind flag)

**Files:** Modify the marketplace listing component under `src/app/marketplace/`.

- [ ] **Step 1:** Show the computed MYR market price on listings. Prefer a store endpoint returning `marketPriceMyr`; if listings read Mercur product data directly, compute from `product.metadata.fmv × FX × market_multiplier` using a storefront port of `displayMarketPrice`. Stays behind `NEXT_PUBLIC_FEATURE_MARKETPLACE` (default off).
- [ ] **Step 2: Verify (flag on locally) + commit** — set `NEXT_PUBLIC_FEATURE_MARKETPLACE=true` locally, confirm the marked-up price, then leave it off. Screenshot to `docs/research/`.
```bash
git add <marketplace listing files>
git commit -m "feat(pricing): marketplace listings show live MYR market price (dormant)"
```

---

## Phase 6 — Config, image auto-pull, final verification

### Task 15: Env + best-effort image auto-pull

- [ ] **Step 1: Env** — add `PRICECHARTING_API_TOKEN` to backend `.env` (value provided out-of-band; never commit). Optional `FX_USD_MYR_URL`. Add both as empty keys + comments in `.env.template`.
- [ ] **Step 2: Investigate image auto-pull** — determine whether a PriceCharting product image URL is obtainable (the Prices API returns none; check whether the product page exposes a reliable image URL). If reliable, add `GET /admin/pricecharting/image?id=` returning a best-effort URL and prefill it in Task 10's page; if not, leave upload-only and note it in `.env.template`/PR. Do NOT block on this.
- [ ] **Step 3: Confirm the job registers** — start the backend, confirm `sync-market-prices` appears among scheduled jobs.
- [ ] **Step 4: Deploy note** — record in the PR that prod must run `medusa db:migrate` (Card fields + `fx_rate`) and set `PRICECHARTING_API_TOKEN`.
- [ ] **Step 5: Commit** `git add backend/packages/api/.env.template … && git commit -m "chore(pricing): env template + image auto-pull + deploy notes"`

### Task 16: Full verification pass

- [ ] **Step 1: Backend** — from `backend/packages/api`: `corepack yarn test:unit` + `corepack yarn test:integration:http` → green.
- [ ] **Step 2: Typecheck** — backend + storefront tsc clean (Stop hook enforces).
- [ ] **Step 3: E2E smoke** (with a real token) — Add-from-PriceCharting → product created → register as card (link carried) → run the sync core once → `market_value` refreshes → vault shows `raw × fx × 1.2`; buyback on that card still pays off the raw value.
- [ ] **Step 4: Finish** — `superpowers:finishing-a-development-branch` to open the PR.

---

## Self-Review (author checklist — completed)

**Spec coverage:** custom Add-from-PriceCharting page (Task 10) · product created with PC link on metadata (Task 4) · link carried Product→Card (Task 5) · Card→Pack via existing PackOdds (no code — inherited) · one card = one grade + distinct handle (Task 4 slug) · daily refresh + 1 req/s + guardrails (Task 8) · +20% multiplier per-card/default/editable (Tasks 5, 10, 11) · USD→MYR FX + manual override + last-known (Tasks 2, 6, 8) · display-only, internals raw (Tasks 2, 7; buyback/RTP untouched) · surfaces vault/reveal/marketplace (Tasks 12–14) · admin margin + linked indicator (Tasks 7, 10, 11) · image auto-pull + upload fallback (Tasks 10, 15) · token server-side only (Task 15). No requirement unmapped.

**Placeholder scan:** UI tasks (Phase 4–5) use "verify running + screenshot" per repo `testing.md`, a deliberate repo-rule override of the skill's TDD default, not a placeholder. Two spots ("locate the reveal/marketplace component", "if the auto-pull endpoint isn't available yet") name a discovery step with the transform fully specified.

**Type consistency:** `displayMarketPrice`/`effectiveRate`/`resolveFxRate`/`fetchUsdMyr` (pricing.ts), `priceFieldForGrade`/`gradeToGrader`/`PRICE_FIELDS` (pricecharting-grades.ts), `refreshCardPrice` (sync-market-prices.ts), `createProductFromPriceChartingWorkflow`, and `pc_product_id`/`pc_grade`/`market_multiplier`/`pc_synced_at` are used identically across all tasks.
