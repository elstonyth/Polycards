# Slot Multi-Reel (Phase D — open-batch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a customer open **1–3 packs at once** on `/slots/[slug]?count=N` and watch **N vertical reels** spin together, with one atomic `count×price` charge and per-roll sell-back.

**Architecture:** A new backend `open-batch` workflow runs the existing single-open steps in **array-shaped** form (Medusa workflow bodies can't loop, so each step takes `count`/arrays and loops internally) under **one saga** — a single `count×price` debit + N independent rolls + N pull rows, all-or-nothing. A new `POST /store/packs/:slug/open-batch` route validates `count`, runs the workflow, and quotes buyback per roll. A storefront `openBatch` action returns `{ rolls:[{card,pullId,marketValue,buyback}], price, total, balance }`. `SlotMachineClient` sources `count` from `?count=N`, calls `openBatch`, and drives the **already-N-capable** `SlotReelStack` with one `ColumnWinner`/card/offer per roll. **No changes to `SlotReelStack`/`SlotReelColumn`/`reel.ts`.**

**Tech Stack:** Medusa v2 workflows/steps (`@acme/api`), zod guards, Next 16 storefront (Vitest), the existing immersive reel.

## Global Constraints

- **count ∈ [1,3], integer.** Clamp/validate at BOTH boundaries: the storefront action (`openBatch`) and the backend route. Never trust the client `count` for the charge — the backend re-derives `total = count × price`.
- **All-or-nothing.** ONE `mutateCreditAtomic({ amount: -(count*price), floor: 0 })` (single per-customer advisory lock, atomic floor check) + N pull rows in **one workflow saga**. Any roll/record failure rolls back the whole debit AND every pull. NEVER do N separate debits (partial-overspend + loop-in-body both forbidden).
- **Win-rate lock preserved per roll** — each roll is an independent draw via the existing roll logic; no `weight`/`computeOdds` ever reaches the client.
- **Response shape (spec §7):** `{ rolls: [{ pull, card, buyback }], price, total_charged, balance }`. `price` = per-pack; `total_charged` = `count×price` (NEW, authoritative from backend); `balance` = post-debit. Buyback is **quoted in the route** per roll (NOT in the workflow), looping `packsService.quoteBuyback`.
- **Each roll's `card` is a full `RolledCard`** (already carries `pokemon_dex`/`sprite_image` from the pixel-Pokémon feature). Per-roll: `priceTier(card.market_value)` for the column glow, `resolveCardPokemon(card)` + `sprite_image` for the `ColumnWinner`.
- **Reel components are FROZEN.** `SlotReelStack` already renders `count` columns, indexes `winners[i]`, staggers `durationMs = base + i*STAGGER_MS`, and fires `onAllSettled` after the last column. `SlotReelColumn.tsx`, `SlotReelStack.tsx`, `reel.ts` get **no edits**.
- **Resolved design decisions (grounded in spec + research):**
  - Sell-back: render **one `SellBackPanel` per roll** (the panel is multi-instance-safe — its `offer?.pullId` effect resets per offer). One shared `balance` (one debit) → every panel's `onSold` updates the same balance.
  - Reveal: on settle, call `revealPull(pullId)` for **each non-null pullId** (N pings). No new batch-reveal route.
  - A roll that fails its zod guard → **fail the whole batch** (return `{ ok:false }`) — never desync N reels from the charged total.
  - Layout: pass a **smaller `cellSize` when `count>1`** (e.g. 76) so 3 columns fit on narrow viewports (`SlotReelStack` already accepts `cellSize`).
- **Tooling (NOT on PATH):** backend via `corepack yarn` from `backend/packages/api` (`test:unit`, `medusa`); backend tsc `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`; storefront `npm run typecheck` / `npx vitest run` from the repo root. Backend `medusa develop` is running on `:9000` and hot-reloads.
- **Branch:** `feat/slots-multi-reel` (off master). Reel components untouched; `/claw` untouched (the configurator already emits `?count=N` via `ClawClient` `mode='slots'`, stepper capped at 3 — DONE, do not rebuild it).

---

## Task 1: Backend — extract the single-roll core + array-shaped batch steps

**Files:**
- Modify: `backend/packages/api/src/workflows/steps/roll-pack.ts` (extract a reusable `rollOne` helper; keep `rollPackStep` behavior byte-identical)
- Create: `backend/packages/api/src/workflows/steps/roll-pack-batch.ts`
- Create: `backend/packages/api/src/workflows/steps/charge-pack-batch.ts`
- Create: `backend/packages/api/src/workflows/steps/record-pulls-batch.ts`
- Create: `backend/packages/api/src/workflows/steps/decrement-card-stock-batch.ts`
- Test: `backend/packages/api/src/workflows/steps/__tests__/roll-pack-batch.unit.spec.ts`

**Interfaces:**
- Produces:
  - `rollOne(packs: PacksModuleService, packId: string): Promise<RolledCard>` (the existing draw, extracted)
  - `rollPackBatchStep(input: { pack_id: string; count: number }) → StepResponse<RolledCard[]>` (read-only, no compensation)
  - `chargePackBatchStep(input: { pack_id: string; customer_id: string; count: number }) → StepResponse<{ price: number; total: number; balance: number }, { creditTransactionId: string } | undefined>` (compensated: `deleteCreditTransactions`)
  - `recordPullsBatchStep(input: { customer_id: string; pack_id: string; card_ids: string[] }) → StepResponse<Pull[], { pullIds: string[] }>` (compensated: `deletePulls(pullIds)`)
  - `decrementCardStockBatchStep(input: { items: { card_id: string; pull_id: string }[] }) → StepResponse<void, …>` (best-effort, compensated +1 each)

- [ ] **Step 1: Extract `rollOne` from `roll-pack.ts` (behavior-preserving).**

In `roll-pack.ts`, move the body of `rollPackStep` (pack-active check → `listPackOdds` → weighted `Math.random` pick → `listCards` → build `RolledCard`) into an exported async helper, and have `rollPackStep` call it. This keeps single-open byte-identical AND lets the batch reuse the exact draw.

```ts
// roll-pack.ts — add ABOVE rollPackStep, keep RolledCard type as-is.
export async function rollOne(
  packs: PacksModuleService,
  packId: string,
): Promise<RolledCard> {
  const [pack] = await packs.listPacks({ slug: packId, status: 'active' }, { take: 1 });
  if (!pack) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Pack '${packId}' is not available.`);
  const odds = await packs.listPackOdds({ pack_id: packId }, { take: 1000 });
  if (odds.length === 0) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Pack '${packId}' has no odds configured.`);
  const totalWeight = odds.reduce((sum, o) => sum + o.weight, 0);
  if (totalWeight <= 0) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `Pack '${packId}' has invalid odds.`);
  let roll = Math.random() * totalWeight;
  let won = odds[odds.length - 1];
  for (const o of odds) { roll -= o.weight; if (roll < 0) { won = o; break; } }
  const [card] = await packs.listCards({ handle: won.card_id }, { take: 1 });
  if (!card) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Card '${won.card_id}' not found.`);
  return {
    handle: card.handle, name: card.name, set: card.set, grader: card.grader,
    grade: card.grade, rarity: won.rarity, market_value: Number(card.market_value),
    image: card.image, pokemon_dex: card.pokemon_dex ?? null, sprite_image: card.sprite_image ?? null,
  };
}
```
Then `rollPackStep`'s invoke becomes: `const packs = container.resolve<PacksModuleService>(PACKS_MODULE); return new StepResponse(await rollOne(packs, input.pack_id));`

- [ ] **Step 2: Write the failing batch-roll test.**

`__tests__/roll-pack-batch.unit.spec.ts` — drive `rollOne` with a stubbed `PacksModuleService` (mirror any existing roll-pack unit test; if none, stub `listPacks`/`listPackOdds`/`listCards`) and assert it returns a `RolledCard` with `pokemon_dex`/`sprite_image` keys and a `rarity` from the won odds row. Assert calling it 3× yields 3 results (independent draws).

```bash
cd backend/packages/api && corepack yarn test:unit --testPathPattern roll-pack-batch.unit
```
Expected: FAIL (file/helper not wired).

- [ ] **Step 3: `roll-pack-batch.ts`.**
```ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { rollOne, type RolledCard } from './roll-pack';

export type RollPackBatchInput = { pack_id: string; count: number };

// Read-only (no compensation). Loops INSIDE the step (the workflow body can't
// loop). N independent draws — win-rate lock holds per roll.
export const rollPackBatchStep = createStep(
  'roll-pack-batch',
  async (input: RollPackBatchInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const cards: RolledCard[] = [];
    for (let i = 0; i < input.count; i++) cards.push(await rollOne(packs, input.pack_id));
    return new StepResponse(cards);
  },
);
export default rollPackBatchStep;
```

- [ ] **Step 4: `charge-pack-batch.ts`** — mirror `charge-pack-open.ts` but ONE `count×price` debit.
```ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type ChargePackBatchInput = { pack_id: string; customer_id: string; count: number };

export const chargePackBatchStep = createStep(
  'charge-pack-batch',
  async (input: ChargePackBatchInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const [pack] = await packs.listPacks({ slug: input.pack_id }, { take: 1 });
    const price = Number(pack?.price ?? 0);
    const total = price * input.count;
    if (total === 0) {
      const balance = await packs.creditBalance(input.customer_id);
      return new StepResponse({ price, total, balance }, undefined);
    }
    const { id, balance } = await packs.mutateCreditAtomic({
      customerId: input.customer_id, amount: -total, reason: 'pack_open', floor: 0,
    });
    return new StepResponse({ price, total, balance }, { creditTransactionId: id });
  },
  async (data, { container }) => {
    if (!data?.creditTransactionId) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deleteCreditTransactions([data.creditTransactionId]);
  },
);
export default chargePackBatchStep;
```

- [ ] **Step 5: `record-pulls-batch.ts`** — mirror `record-pull.ts`, insert N, compensate ALL.
```ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type RecordPullsBatchInput = { customer_id: string; pack_id: string; card_ids: string[] };

export const recordPullsBatchStep = createStep(
  'record-pulls-batch',
  async (input: RecordPullsBatchInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const pulls = await packs.createPulls(
      input.card_ids.map((card_id) => ({
        customer_id: input.customer_id, pack_id: input.pack_id, card_id,
      })),
    );
    return new StepResponse(pulls, { pullIds: pulls.map((p) => p.id) });
  },
  async (data, { container }) => {
    if (!data?.pullIds?.length) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deletePulls(data.pullIds);
  },
);
export default recordPullsBatchStep;
```
> **Implementer note:** confirm `createPulls` accepts an array + that `Pull` has the same fields `record-pull.ts` relies on (`id`, `rolled_at`, `revealed_at`). Read `record-pull.ts` for the exact create shape (e.g. any default fields) and mirror it per element.

- [ ] **Step 6: `decrement-card-stock-batch.ts`** — mirror `decrement-card-stock.ts`, loop internally, best-effort (never throw), compensate +1 each.

Read `decrement-card-stock.ts` and wrap its single-item logic in a loop over `input.items`, accumulating the compensation list. Keep its "never gates a pull / best-effort" contract.

- [ ] **Step 7: Run the test (GREEN) + backend tsc.**
```bash
cd backend/packages/api && corepack yarn test:unit --testPathPattern roll-pack-batch.unit && node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```
Expected: pass + clean.

- [ ] **Step 8: Commit** — `feat(packs): array-shaped open-batch steps (roll/charge/record/stock)`.

---

## Task 2: Backend — `open-batch` workflow

**Files:**
- Create: `backend/packages/api/src/workflows/open-batch.ts`

**Interfaces:**
- Consumes: the Task 1 steps.
- Produces: `openBatchWorkflow(scope).run({ input: { pack_id: string; customer_id: string; count: number } }) → { result: { rolls: RolledCard[]; pulls: Pull[]; price: number; total: number; balance: number } }`

- [ ] **Step 1: Compose the workflow (no loops in the body — only `transform`).**
```ts
import { createWorkflow, transform, WorkflowResponse } from '@medusajs/framework/workflows-sdk';
import { rollPackBatchStep } from './steps/roll-pack-batch';
import { chargePackBatchStep } from './steps/charge-pack-batch';
import { recordPullsBatchStep } from './steps/record-pulls-batch';
import { decrementCardStockBatchStep } from './steps/decrement-card-stock-batch';
import { emitEventStep } from './steps/emit-event'; // confirm path from open-pack.ts import

export type OpenBatchInput = { pack_id: string; customer_id: string; count: number };

export const openBatchWorkflow = createWorkflow(
  'open-batch',
  function (input: OpenBatchInput) {
    const cards = rollPackBatchStep(input);          // RolledCard[] (N independent draws)
    const charge = chargePackBatchStep(input);       // ONE count×price debit
    const recordInput = transform({ input, cards }, (d) => ({
      customer_id: d.input.customer_id,
      pack_id: d.input.pack_id,
      card_ids: d.cards.map((c) => c.handle),
    }));
    const pulls = recordPullsBatchStep(recordInput); // N pull rows
    const stockInput = transform({ cards, pulls }, (d) => ({
      items: d.cards.map((c, i) => ({ card_id: c.handle, pull_id: d.pulls[i].id })),
    }));
    decrementCardStockBatchStep(stockInput);         // best-effort earmark ×N
    const eventData = transform({ input, pulls }, (d) =>
      d.pulls.map((p) => ({ pack_id: d.input.pack_id, pull_id: p.id })),
    );
    emitEventStep({ eventName: 'pack.opened', data: eventData }); // confirm emitEventStep accepts an array; else emit per-pull
    const result = transform({ cards, pulls, charge }, (d) => ({
      rolls: d.cards, pulls: d.pulls, price: d.charge.price, total: d.charge.total, balance: d.charge.balance,
    }));
    return new WorkflowResponse(result);
  },
);
export default openBatchWorkflow;
```
> **Implementer note:** open `open-pack.ts` to copy the EXACT `emitEventStep` import path + its `pack.opened` data shape, and confirm whether it accepts an array (emit N events — one per pull — so the leaderboard/live-feed counts each pull). If it only takes one event, emit per-pull is not loopable in the body → make `emitEventStep` (or a new `emitEventsBatchStep`) take an array and loop internally. Mirror `open-pack.ts`'s event payload fields exactly.

- [ ] **Step 2: Backend tsc clean.**
```bash
cd backend/packages/api && node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

- [ ] **Step 3: Commit** — `feat(packs): open-batch workflow (one count×price debit, N rolls, saga)`.

---

## Task 3: Backend — `open-batch` route + middleware

**Files:**
- Create: `backend/packages/api/src/api/store/packs/[slug]/open-batch/route.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (new matcher + bearer + limiter)
- Modify: `backend/packages/api/src/api/utils/rate-limit.ts` (add `createPackOpenBatchRateLimit`)

**Interfaces:**
- Produces: `POST /store/packs/:slug/open-batch` body `{ count: number }` → `{ rolls: [{ pull, card, buyback }], price, total_charged, balance }`.

- [ ] **Step 1: Route handler** — mirror `open/route.ts`; validate `count`, run the workflow, loop `quoteBuyback` per roll.
```ts
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { openBatchWorkflow } from '../../../../../workflows/open-batch';
// + the SAME buyback constants/helpers open/route.ts imports (FLAT_PERCENT, vault/instant deadline calc)

const MAX_COUNT = 3;

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const { slug } = req.params;
  const raw = (req.body as { count?: unknown } | undefined)?.count;
  const count = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `'count' must be an integer between 1 and ${MAX_COUNT}.`);
  }
  const { result } = await openBatchWorkflow(req.scope).run({
    input: { pack_id: slug, customer_id: customerId, count },
  });
  const packsService: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const rolls = await Promise.all(
    result.rolls.map(async (card, i) => {
      const pull = result.pulls[i];
      const buyback = await packsService.quoteBuyback(
        slug, { rolled_at: pull.rolled_at, revealed_at: pull.revealed_at }, card.market_value,
      );
      return { pull, card, buyback: { ...buyback /* + vault_percent/vault_amount/instant_deadline_ms exactly as open/route.ts builds them, per card.market_value */ } };
    }),
  );
  res.json({ rolls, price: result.price, total_charged: result.total, balance: result.balance });
}
```
> **Implementer note:** open `open/route.ts` and copy the EXACT buyback object construction (the `vault_percent`/`vault_amount`/`instant_deadline_ms` fields + any constants) so each roll's buyback matches the single-open contract byte-for-byte. Use the relative import depth that matches `open-batch/route.ts`'s nesting (one level deeper than `open/route.ts` — verify the `../` count).

- [ ] **Step 2: Rate limiter** — add to `rate-limit.ts`:
```ts
export const createPackOpenBatchRateLimit = () => createEnvRateLimit({ name: 'pack-open-batch' });
```
(One batch = one request = up to 3 opens; give it its own budget instead of reusing the single-open limiter. Mirror `createPackOpenRateLimit`'s shape.)

- [ ] **Step 3: Middleware matcher** — in `middlewares.ts` `routes`, add (near the `/store/packs/*/open` entry):
```ts
{
  matcher: '/store/packs/*/open-batch',
  method: 'POST',
  middlewares: [authenticate('customer', ['bearer']), createPackOpenBatchRateLimit()],
},
```
(Import `createPackOpenBatchRateLimit`. The `/open` glob does NOT cover `/open-batch`, so this is required for auth.)

- [ ] **Step 4: Backend tsc + (optional, services up) manual curl.**
```bash
cd backend/packages/api && node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```
Optional smoke (backend running, a customer bearer + credits): `POST /store/packs/pokemon-rookie/open-batch {count:2}` → 200 with `rolls.length===2`, `total_charged===2×price`, balance decremented once.

- [ ] **Step 5: Commit** — `feat(packs): POST /store/packs/:slug/open-batch route + rate limit`.

---

## Task 4: Storefront — `openBatch` action

**Files:**
- Modify: `src/lib/actions/packs.ts` (add `openBatch` + `OpenBatchResult`; reuse `WonCardSchema`/`OpenBuybackSchema`/`PACKS_RULES`/`friendlyError`/`getAuthToken`)
- Test: `src/lib/__tests__/open-batch.test.ts` (pure mapping/clamp test where feasible)

**Interfaces:**
- Produces:
```ts
export type BatchRoll = {
  card: WonCard;
  pullId: string | null;
  marketValue: number;
  buyback: { percent; amount; vaultPercent: number|null; vaultAmount: number|null; instantDeadlineMs: number|null } | null;
};
export type OpenBatchResult =
  | { ok: true; rolls: BatchRoll[]; price: number | null; total: number | null; balance: number | null }
  | { ok: false; error: string; needsAuth?: boolean; needsTopUp?: boolean };
export async function openBatch(slug: string, count: number): Promise<OpenBatchResult>;
```

- [ ] **Step 1: Implement `openBatch`** — mirror `openPack` (slug+token guards), clamp `count` to int 1..3, POST `/store/packs/:slug/open-batch` body `{ count }`, then **map each roll** exactly like `openPack` maps its single card+buyback (read `image` from the RAW roll card, `parseOne(WonCardSchema)`/`parseOne(OpenBuybackSchema)` per roll). **If any roll's `WonCardSchema` parse is null → return `{ ok:false, error:'Got an unexpected response…' }`** (fail whole batch). Map `total` from `total_charged`. Reuse `PACKS_RULES`/`PACKS_FALLBACK` + `needsAuth`/`needsTopUp` in the catch (verbatim from `openPack`).

(Show the full function in the implementation; it is `openPack` with: a `count` clamp, `body:{count}`, `rolls.map` of the existing per-card mapping, and `total` added.)

- [ ] **Step 2: Test** — assert `openBatch` clamps `count` (0→reject/clamp, 5→3) and that the per-roll mapping reads `image` from raw + nulls a bad buyback. (Mock `sdk.client.fetch`/`getAuthToken` as the existing action tests do, or unit-test an extracted pure `mapRoll` helper.) RED → GREEN.
```bash
npx vitest run src/lib/__tests__/open-batch.test.ts
```

- [ ] **Step 3: `npm run typecheck` clean. Commit** — `feat(slots): openBatch server action (1..3 rolls)`.

---

## Task 5: Thread `count` through the reveal page

**Files:**
- Modify: `src/app/slots/[slug]/page.tsx`

- [ ] **Step 1: Read + clamp `?count` and pass it down.**
```tsx
export default async function SlotPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ count?: string }>;
}) {
  const { slug } = await params;
  const { count: countRaw } = await searchParams;
  const parsed = Number(countRaw);
  const count = Number.isInteger(parsed) ? Math.min(3, Math.max(1, parsed)) : 1;
  // …existing pack/recentPulls load…
  return <SlotMachineClient pack={base.pack} recentPulls={recentPulls} count={count} />;
}
```
(Keep the existing data-loading + not-found handling exactly as-is; only add `searchParams` + the `count` prop.)

- [ ] **Step 2: `npm run typecheck`** (will error on the new `count` prop until Task 6 — expected; or do Task 6 first). Commit with Task 6.

---

## Task 6: Rewire `SlotMachineClient` to N reels

**Files:**
- Modify: `src/app/slots/[slug]/SlotMachineClient.tsx`

**Interfaces:**
- Consumes: `count: number` prop; `openBatch`; `SlotReelStack` (unchanged); `SellBackPanel` (unchanged).

- [ ] **Step 1: Add the `count` prop + drop the hardcode.**
- Signature → `({ pack, recentPulls, count }: { pack: ResolvedPack & Pack; recentPulls: RecentPull[]; count: number })`.
- Delete `const COLUMN_COUNT = 1;`. Use `count` everywhere `COLUMN_COUNT` was. Derive a `cellSize` for density: `const cellSize = count > 1 ? 76 : 96;`.

- [ ] **Step 2: N-array state.**
- `spin` state: `card: WonCard` → `cards: WonCard[]` (keep `winners: ColumnWinner[]`, `tier` → drop single `tier` or keep `tiers: Tier[]`).
- `pending` ref: `{ balance: number|null; offer: SellBackOffer|null; card: WonCard }` → `{ balance: number|null; offers: (SellBackOffer|null)[]; cards: WonCard[] }`.
- `offer` state → `offers` state: `(SellBackOffer|null)[]` (init `[]`).

- [ ] **Step 3: `handleSpin` → `openBatch` + per-roll build.**
- Replace `const res = await openPack(pack.id)` with `const res = await openBatch(pack.id, count)`.
- Affordability: `balance < cost` → `balance < cost * count`; the `setNeedsTopUp`/error copy reflect the batch total.
- Build per roll (map `res.rolls`): for each `roll`, `priceTier(roll.marketValue)`, `resolveCardPokemon(roll.card)`, `custom = roll.card.sprite_image?.trim() || null`, `ColumnWinner = { dex, image: custom ?? (dex===null ? POKEBALL_PLACEHOLDER : undefined), name: name ?? roll.card.name, tier }`. Build `offers[i]` from `roll` (same `SellBackOffer` construction as today, per roll). `cards[i] = roll.card`.
- `pending.current = { balance: res.balance, offers, cards }`. `setSpin({ nonce: Date.now(), cards, winners, tiers })`. (One shared post-debit `balance`.)

- [ ] **Step 4: `handleSettled` → N.**
- `setBalance(held.balance)` once. `setOffers(held.offers)`.
- Prepend **N** `RecentPull`s (one per `held.cards[i]`), still slice(0,12).
- Big-win SFX from the BEST roll: `const big = held.cards.some(c => c.rarity === 'Epic' || c.rarity === 'Legendary')`.
- Announce summarizes N (e.g. `Won ${cards.length} cards`).

- [ ] **Step 5: Render N.**
- `<SlotReelStack count={count} cellSize={cellSize} winners={…spin?.winners…} … />` (winners already length===count).
- Replace the single won-card block: when `phase==='landed'`, map `spin.cards` → a row of N card thumbnails, each with its own `<SellBackPanel offer={offers[i]} active onSellBack={sellBackPull} onReveal={revealPull} onSold={refreshBalance} />`. `refreshBalance` already sets the shared balance.
- On settle, fire `revealPull(offers[i].pullId)` for each non-null offer (the panel's `onReveal` handles per-panel; ensure each panel gets its own offer so its reveal ping fires).

- [ ] **Step 6: typecheck + Commit** (with Task 5) — `feat(slots): drive N reels from openBatch (count 1..3)`.
```bash
npm run typecheck
```

---

## Task 7: Whole-feature verification

- [ ] **Step 1: Typechecks + units.**
```bash
cd backend/packages/api && node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit && corepack yarn test:unit --testPathPattern "roll-pack-batch|open-batch"
cd ../../.. && npm run typecheck && npx vitest run
```
- [ ] **Step 2: Build storefront** (`npm run build`) + serve standalone `:4000`; backend already on `:9000`.
- [ ] **Step 3: Manual/Playwright** — open `/slots/pokemon-rookie?count=3` (logged in, ≥3×price credits) → 3 reels spin staggered → all land → 3 prize cards + 3 sell-back panels; balance dropped by exactly `3×price` once. Try `count=2`. Confirm `count=1` still works (single reel, single charge) — no regression.
- [ ] **Step 4: Backend integration (optional, services up)** — `customer-gacha`/a new `open-batch` integration test: all-or-nothing (1 debit + N pulls; whole-batch reject + rollback on a forced failure; balance unchanged on reject; cap at 3 rejects count=4).

---

## Self-Review

**Spec coverage (§7 + Phase D §14):** `open-batch {count:1..3}` route ✅ (Task 3); all-or-nothing one `count×price` debit ✅ (Task 1 charge + Task 2 saga); N rolls, lock-per-roll ✅ (Task 1 `rollOne`×N); returns `{rolls:[{pull,card,buyback}], price, total_charged, balance}` ✅ (Task 3); `openBatch` action ✅ (Task 4); wire N reels to N rolls ✅ (Tasks 5–6); sell-back focused/per-column ✅ (Task 6, one panel per roll). Configurator already emits `?count=N` (ClawClient) — not rebuilt (spec §5 stale).

**Placeholder scan:** the few "Implementer note: open X and copy the exact …" items point at concrete template files (`open-pack.ts`, `open/route.ts`, `record-pull.ts`, `decrement-card-stock.ts`, `emit-event`) the implementer must mirror byte-for-byte — they exist on this branch; this is "mirror this real code," not a TBD. Every new step/workflow/route/action shows full code or exact signatures.

**Type consistency:** `RolledCard` (with `pokemon_dex`/`sprite_image`) flows model→`rollOne`→`rollPackBatchStep`→workflow→route `rolls[].card`→`openBatch` `BatchRoll.card`→`WonCard`→`ColumnWinner`. `count:number` is the single source (page→client→stack). `total`/`total_charged` is the one new field, surfaced end-to-end. Reel components (`SlotReelStack`/`Column`/`reel.ts`) are unchanged and already N-indexed.
