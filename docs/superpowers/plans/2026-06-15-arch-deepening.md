# Architecture Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn six shallow/scattered modules into deep, well-tested seams without changing any observable behavior.

**Architecture:** Two waves. Wave 1 (backend) adds three pure/own-data seams in the `packs` module — `toMoney`, card-view helpers, and real `PacksModuleService` methods — and rewires the routes/steps that duplicated that logic. Wave 2 (storefront) adds a zod-validated fetch seam, one money formatter, a `CardTile` base, and a `Reveal` stagger prop. Every change is guarded by the existing jest integration specs (backend) and vitest + Playwright visual baseline (storefront).

**Tech Stack:** Medusa v2 / Mercur (backend, jest + @swc/jest, `*.unit.spec.ts` for unit tier), Next.js 16 / React 19 storefront (vitest 3, Playwright capture on standalone :4000), zod (new storefront dep, Wave 2).

**Branch:** `feat/arch-deepening` (in-place; carries the committed buyback-reveal baseline `35f6d68`). No worktree (user choice).

---

## Honest scope correction (from reading the real route code)

The architecture review counted "6 routes duplicate card shaping." Reading the
code: they are **similar, not identical**. Exact card shapes differ —
`pulls/recent` is a 5-field **flat** object; `profiles` card omits `rarity`
(it's a sibling field); only **`store/packs/[slug]`** and **`store/vault`**
share the same 8-field card object. So:

- **`toMoney`** is the one truly universal seam — every `Number(market_value)` /
  `pack.price` site (~15). Adopt everywhere.
- **`makeRarityOf`** removes the `rarityByPair` Map duplication — `vault`,
  `pulls/recent`, `profiles` (3 sites, all default `"Common"`).
- **`toCardView`** (8-field) is adopted **only** by `store/packs/[slug]` and
  `store/vault`. `pulls/recent` and `profiles` keep their bespoke field sets
  (using `toMoney` + `makeRarityOf` only) — adopting the full shape would **add
  fields = behavior change**, which the contract forbids.

This is the correct deepening: consolidate what is genuinely identical, leave
what differs alone.

## Candidate 2 scope (Medusa module isolation)

`creditBalance(packs, …)` takes the service → folds into a method cleanly.
`getCardStockByHandle(container, …)` / `findCardInventoryTarget` resolve the
**product/inventory** module via QUERY — cross-module, so they **stay** at the
API/workflow layer (a packs-module method must not reach into inventory data).
Pure math (`resolveBuybackRate`, `buybackAmount`, `economy`, `odds-math`,
`hasEnoughCredit`) stays pure **underneath** the service. The real deepening:
a `creditBalance` method + a `quoteBuyback` method that removes the
open-route↔vault-route buyback re-query the review flagged.

---

# WAVE 1 — Backend backbone

All Wave-1 commands run from `backend/packages/api`. Unit tests:
`npm run test:unit` (jest, `*.unit.spec.ts` under `src/**/__tests__/`).
Integration: `npm run test:integration:http` / `:modules` (slow; `--forceExit`
is built in; if jest wedges pre-output, `Get-Process node | Stop-Process -Force`
and rerun).

## Task 1: `toMoney` money seam

**Files:**

- Create: `backend/packages/api/src/modules/packs/money.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/money.unit.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// money.unit.spec.ts
import { toMoney } from '../money';

describe('toMoney', () => {
  it('passes through a plain number', () => {
    expect(toMoney(12.34)).toBe(12.34);
  });
  it('coerces a numeric string (numeric column shape)', () => {
    expect(toMoney('0.15')).toBe(0.15);
  });
  it('coerces a BigNumber-like value via its numeric valueOf', () => {
    expect(toMoney({ valueOf: () => 7.5 } as unknown as number)).toBe(7.5);
  });
  it('returns NaN-free 0 for null/undefined money is NOT assumed — preserves Number() semantics', () => {
    // Behavior-preserving: current call sites use Number(x); Number(null)=0,
    // Number(undefined)=NaN. Lock that exact behavior so nothing shifts.
    expect(toMoney(null)).toBe(0);
    expect(Number.isNaN(toMoney(undefined))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- money.unit.spec`
Expected: FAIL — cannot find module `../money`.

- [ ] **Step 3: Write minimal implementation**

```ts
// money.ts
import type { BigNumberValue } from '@medusajs/framework/types';

// The single coercion from a stored money value (Medusa numeric column →
// BigNumber | numeric string | number) to a JSON-safe JS number. Behavior-
// preserving replacement for the ~15 inline `Number(card.market_value)` /
// `Number(pack.price)` call sites: it is exactly `Number(value)`, centralized
// so the rounding/serialization rule lives in one place. USD decimals, never
// cents.
export function toMoney(
  value: BigNumberValue | number | string | null | undefined,
): number {
  return Number(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- money.unit.spec`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/money.ts backend/packages/api/src/modules/packs/__tests__/money.unit.spec.ts
git commit -m "feat(packs): add toMoney seam for money serialization"
```

## Task 2: card-view helpers (`cardByHandle`, `makeRarityOf`, `toCardView`)

**Files:**

- Create: `backend/packages/api/src/modules/packs/card-view.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/card-view.unit.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// card-view.unit.spec.ts
import { cardByHandle, makeRarityOf, toCardView } from '../card-view';

const card = {
  handle: 'pikachu-001',
  name: 'Pikachu',
  set: 'Base',
  grader: 'PSA',
  grade: '10',
  market_value: '0.15',
  image: '/p.png',
};

describe('cardByHandle', () => {
  it('indexes cards by handle', () => {
    const m = cardByHandle([card]);
    expect(m.get('pikachu-001')).toBe(card);
    expect(m.size).toBe(1);
  });
});

describe('makeRarityOf', () => {
  const odds = [{ pack_id: 'p1', card_id: 'pikachu-001', rarity: 'Epic' }];
  it('looks rarity up by (pack, card) pair', () => {
    const rarityOf = makeRarityOf(odds);
    expect(rarityOf('p1', 'pikachu-001')).toBe('Epic');
  });
  it('defaults missing pairs to Common', () => {
    const rarityOf = makeRarityOf(odds);
    expect(rarityOf('p9', 'nope')).toBe('Common');
  });
});

describe('toCardView', () => {
  it('shapes the canonical 8-field card view with money-normalized FMV', () => {
    expect(toCardView(card, 'Epic')).toEqual({
      handle: 'pikachu-001',
      name: 'Pikachu',
      set: 'Base',
      grader: 'PSA',
      grade: '10',
      rarity: 'Epic',
      market_value: 0.15,
      image: '/p.png',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- card-view.unit.spec`
Expected: FAIL — cannot find module `../card-view`.

- [ ] **Step 3: Write minimal implementation**

```ts
// card-view.ts
import { toMoney } from './money';

// The display fields shared by the card-detail responses. Card.market_value is
// a numeric column; everything else is a plain string. Kept loose (the Card
// model carries more) so callers pass a Card row directly.
export type CardLike = {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  market_value: unknown;
  image: string;
};

// Index a card list by its stable business key (Card.handle === the join key
// used by odds rows and pulls). Replaces `new Map(cards.map(c => [c.handle, c]))`
// repeated across the card routes.
export function cardByHandle<T extends { handle: string }>(
  cards: T[],
): Map<string, T> {
  return new Map(cards.map((c) => [c.handle, c]));
}

type OddsRow = { pack_id: string; card_id: string; rarity: string };

// Per-pack rarity lookup: rarity belongs to the (pack, card) link (PackOdds),
// not the card. Replaces the hand-built `rarityByPair` Map + `?? "Common"`
// default duplicated in the vault, recent-pulls, and profile routes. The key
// separator is internal — callers only see the (packId, cardId) lookup.
export function makeRarityOf(
  odds: OddsRow[],
): (packId: string, cardId: string) => string {
  const byPair = new Map(
    odds.map((o) => [`${o.pack_id} ${o.card_id}`, o.rarity]),
  );
  return (packId, cardId) => byPair.get(`${packId} ${cardId}`) ?? 'Common';
}

// The canonical 8-field public card view, with FMV normalized to a JSON number.
// Adopted ONLY by routes whose card object is exactly these fields
// (store/packs/[slug] and store/vault). Routes with a different field set
// (pulls/recent = 5 flat fields; profiles = no rarity) keep their own shape and
// use toMoney + makeRarityOf only — see the plan's scope note.
export function toCardView(card: CardLike, rarity: string) {
  return {
    handle: card.handle,
    name: card.name,
    set: card.set,
    grader: card.grader,
    grade: card.grade,
    rarity,
    market_value: toMoney(card.market_value),
    image: card.image,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- card-view.unit.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/card-view.ts backend/packages/api/src/modules/packs/__tests__/card-view.unit.spec.ts
git commit -m "feat(packs): add card-view assembler helpers"
```

## Task 3: adopt the seams in the two exact-match store routes

**Files:**

- Modify: `backend/packages/api/src/api/store/packs/[slug]/route.ts`
- Modify: `backend/packages/api/src/api/store/vault/route.ts`

> No new test — the existing integration specs are the characterization net.
> Run them green BEFORE editing, then green AFTER.

- [ ] **Step 1: Baseline the guard specs (must be green before touching code)**

Run: `npm run test:integration:http -- store-packs-price-contract pack-open-charge vault-buyback`
Expected: PASS. (If a spec is already red on `feat/arch-deepening`, stop and report — do not refactor over a red baseline.)

- [ ] **Step 2: Rewrite `store/packs/[slug]/route.ts` join block**

Replace the `cardByHandle` Map + `entries` map (the block from
`const cardByHandle = new Map(...)` through the `.filter(...)`) with:

```ts
import { cardByHandle, toCardView } from '../../../../modules/packs/card-view';
import { toMoney } from '../../../../modules/packs/money';
// ...
const byHandle = cardByHandle(cards);

// Join each odds row to its card; drop orphaned odds whose card is missing.
// rarity comes from the odds row — the card's tier IN THIS PACK. o.weight
// (the secret win rate) is intentionally NOT included.
const entries = odds
  .map((o) => {
    const card = byHandle.get(o.card_id);
    return card ? toCardView(card, o.rarity) : null;
  })
  .filter((e): e is NonNullable<typeof e> => e !== null);
```

And in the `res.json` pack shape, wrap the price: `price: toMoney(pack.price),`.

- [ ] **Step 3: Rewrite `store/vault/route.ts` join block**

Replace the `cardByHandle` / `rarityByPair` Maps and the `items` map's `card`
object with the seams (keep the `buyback` wrapper, the FMV-finite drop, and
`pack_title` exactly as they are):

```ts
import {
  cardByHandle,
  makeRarityOf,
  toCardView,
} from '../../../modules/packs/card-view';
import { toMoney } from '../../../modules/packs/money';
// ...
const byHandle = cardByHandle(cards);
const packBySlug = new Map(packRows.map((p) => [p.slug, p]));
const rarityOf = makeRarityOf(oddsRows);

const items = pulls
  .map((p) => {
    const card = byHandle.get(p.card_id);
    if (!card) return null;
    const marketValue = toMoney(card.market_value);
    if (!Number.isFinite(marketValue)) return null;
    const pack = packBySlug.get(p.pack_id);
    const { percent, rate_type } = resolveBuybackRate(pack, p.rolled_at);
    return {
      pull_id: p.id,
      rolled_at: p.rolled_at,
      pack_id: p.pack_id,
      pack_title: pack?.title ?? p.pack_id,
      card: toCardView(card, rarityOf(p.pack_id, p.card_id)),
      buyback: {
        percent,
        amount: buybackAmount(marketValue, percent),
        rate_type,
      },
    };
  })
  .filter((e): e is NonNullable<typeof e> => e !== null);
```

- [ ] **Step 4: Typecheck + rerun the guard specs**

Run: `npx tsc --noEmit -p tsconfig.json`
Then: `npm run test:integration:http -- store-packs-price-contract vault-buyback`
Expected: PASS, identical output (the specs assert JSON shape + buyback amounts).

- [ ] **Step 5: Commit**

```bash
git add "backend/packages/api/src/api/store/packs/[slug]/route.ts" "backend/packages/api/src/api/store/vault/route.ts"
git commit -m "refactor(packs): route packs/[slug] + vault through card-view seam"
```

## Task 4: adopt `toMoney` + `makeRarityOf` in the bespoke-shape routes

**Files:**

- Modify: `backend/packages/api/src/api/store/pulls/recent/route.ts`
- Modify: `backend/packages/api/src/api/store/profiles/[handle]/route.ts`

> These keep their own field sets. Only the money coercion and rarity lookup
> are deduped — the response shape must stay byte-identical.

- [ ] **Step 1: `pulls/recent` — swap the rarity Map + Number()**

Replace the `rarityByPair` Map and its inline lookup with `makeRarityOf`, and
`Number(card.market_value)` with `toMoney(card.market_value)`. The returned
object stays the same 5 flat fields (`handle, name, rarity, market_value,
image, pack_id, rolled_at`):

```ts
import {
  cardByHandle,
  makeRarityOf,
} from '../../../../modules/packs/card-view';
import { toMoney } from '../../../../modules/packs/money';
// ...
const byHandle = cardByHandle(cards);
const rarityOf = makeRarityOf(oddsRows);

const recent = pulls
  .map((p) => {
    const card = byHandle.get(p.card_id);
    if (!card) return null;
    return {
      handle: card.handle,
      name: card.name,
      rarity: rarityOf(p.pack_id, p.card_id),
      market_value: toMoney(card.market_value),
      image: card.image,
      pack_id: p.pack_id,
      rolled_at: p.rolled_at,
    };
  })
  .filter((e): e is NonNullable<typeof e> => e !== null);
```

- [ ] **Step 2: `profiles/[handle]` — reuse `makeRarityOf` + `toMoney`, keep the local `Rarity` type and 7-field card**

Replace the local `rarityByPair`/`rarityOf` with `makeRarityOf` (it already
defaults to `"Common"`, matching the existing `rarityOf`), and the two
`Number(card.market_value)` sites with `toMoney`. Keep `byRarity` keyed by the
local `RARITIES`. The `recent[].card` object stays its 7 fields (NO `rarity`
inside the card — `rarity` remains a sibling).

```ts
import { makeRarityOf } from '../../../../modules/packs/card-view';
import { toMoney } from '../../../../modules/packs/money';
// ...
const byHandle = new Map(cards.map((c) => [c.handle, c]));
const priceBySlug = new Map(packRows.map((p) => [p.slug, p.price]));
const rarityOf = makeRarityOf(odds) as (p: string, c: string) => Rarity;
```

Then `volume += card ? toMoney(card.market_value) : 0;` and in `recent`'s card:
`market_value: toMoney(card.market_value),`.

> Note: `makeRarityOf` returns `string`; cast to the local `Rarity` union at the
> call site (values are the same admin-controlled set). Verify `byRarity[...]`
> indexing still type-checks.

- [ ] **Step 3: Typecheck + run guard specs**

Run: `npx tsc --noEmit -p tsconfig.json`
Then: `npm run test:integration:http -- public-profile customer-gacha`
Expected: PASS. (recent-pulls has no dedicated spec; rely on typecheck + the shared helpers' unit tests + manual diff of the returned shape.)

- [ ] **Step 4: Commit**

```bash
git add "backend/packages/api/src/api/store/pulls/recent/route.ts" "backend/packages/api/src/api/store/profiles/[handle]/route.ts"
git commit -m "refactor(packs): dedupe rarity lookup + money coercion in recent/profile routes"
```

## Task 5: `toMoney` sweep across admin routes

**Files (modify — apply `toMoney` to each `Number(market_value)` / `Number(price)`):**

- `backend/packages/api/src/api/admin/cards/route.ts`
- `backend/packages/api/src/api/admin/cards/[handle]/route.ts`
- `backend/packages/api/src/api/admin/economy/route.ts`
- `backend/packages/api/src/api/admin/customers/[id]/gacha/route.ts`
- `backend/packages/api/src/api/admin/packs/[slug]/odds/route.ts`

- [ ] **Step 1: Read each file, replace `Number(x.market_value)` / `Number(x.price)` with `toMoney(...)`**

For each file add `import { toMoney } from "../../../../modules/packs/money";`
(adjust depth) and swap every money `Number(...)` for `toMoney(...)`. Do NOT
touch non-money `Number()` calls (counts, weights, pct, stock). Leave each
route's distinct card shape otherwise unchanged — admin routes are not forced
onto `toCardView`.

- [ ] **Step 2: Typecheck + admin spec**

Run: `npx tsc --noEmit -p tsconfig.json`
Then: `npm run test:integration:http -- economy customer-gacha`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/packages/api/src/api/admin
git commit -m "refactor(admin): route money serialization through toMoney"
```

## Task 6: `creditBalance` service method

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts`
- Modify: `backend/packages/api/src/modules/packs/credit-balance.ts` (re-export shim)
- Test: `backend/packages/api/src/modules/packs/__tests__/credit-balance.unit.spec.ts` (existing — keep green)

- [ ] **Step 1: Read the existing `credit-balance.unit.spec.ts`** to see how it constructs a fake `packs` (it passes a stub with `listCreditTransactions`). The method must satisfy the same behavior.

- [ ] **Step 2: Move the paging logic into a method on the service**

```ts
// service.ts
import { MedusaService } from '@medusajs/framework/utils';
import Pack from './models/pack';
import Card from './models/card';
import PackOdds from './models/pack-odds';
import Pull from './models/pull';
import CreditTransaction from './models/credit-transaction';

const BALANCE_PAGE = 1000;

class PacksModuleService extends MedusaService({
  Pack,
  Card,
  PackOdds,
  Pull,
  CreditTransaction,
}) {
  // Customer credit balance = Σ(amount) over the append-only ledger, paged so
  // the result is exact at any ledger size. Integer-cent sum avoids float drift.
  async creditBalance(customerId: string): Promise<number> {
    let cents = 0;
    for (let skip = 0; ; skip += BALANCE_PAGE) {
      const page = await this.listCreditTransactions(
        { customer_id: customerId },
        { skip, take: BALANCE_PAGE, order: { created_at: 'ASC' } },
      );
      for (const t of page) cents += Math.round(Number(t.amount) * 100);
      if (page.length < BALANCE_PAGE) break;
    }
    return cents / 100;
  }
}

export default PacksModuleService;
```

- [ ] **Step 3: Keep `credit-balance.ts` as a thin delegating shim (so existing callers/tests don't churn this task)**

```ts
// credit-balance.ts
import type PacksModuleService from './service';

/** @deprecated call `packs.creditBalance(customerId)` directly. */
export async function creditBalance(
  packs: PacksModuleService,
  customerId: string,
): Promise<number> {
  return packs.creditBalance(customerId);
}
```

- [ ] **Step 4: Run the unit + module test tiers**

Run: `npm run test:unit -- credit-balance.unit.spec`
Then: `npm run test:integration:modules`
Expected: PASS (the existing balance unit test still constructs a stub — confirm it targets the free fn; if it imports the method, adapt to call `packs.creditBalance`).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/modules/packs/credit-balance.ts
git commit -m "refactor(packs): fold creditBalance into the module service"
```

## Task 7: `quoteBuyback` service method — kill the open/vault re-query

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts`
- Modify: `backend/packages/api/src/api/store/packs/[slug]/open/route.ts`
- Modify: `backend/packages/api/src/api/store/vault/route.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/quote-buyback.unit.spec.ts`

- [ ] **Step 1: Write the failing test** (uses a stub service with `listPacks`)

```ts
// quote-buyback.unit.spec.ts — verifies the method composes listPacks +
// resolveBuybackRate + buybackAmount identically to the inline route code.
import PacksModuleService from '../service';

const NOW = 1_750_000_000_000;
function fakePacks(pack: unknown) {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  (svc as unknown as { listPacks: unknown }).listPacks = async () =>
    pack ? [pack] : [];
  return svc;
}

describe('quoteBuyback', () => {
  it('quotes the instant offer for a fresh pull', async () => {
    const packs = fakePacks({ slug: 'p1', buyback_percent: 99 });
    const q = await packs.quoteBuyback('p1', new Date(NOW - 1000), 0.15, NOW);
    expect(q).toEqual({
      percent: 99,
      amount: expect.any(Number),
      rate_type: 'instant',
    });
    expect(q.amount).toBe(
      Math.round((Math.round(0.15 * 100) * 99) / 100) / 100,
    );
  });
  it('falls back to the flat rate when the pack is gone', async () => {
    const packs = fakePacks(null);
    const q = await packs.quoteBuyback('gone', new Date(NOW - 1000), 1, NOW);
    expect(q.rate_type).toBe('instant'); // window still open; flat-floored percent
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`quoteBuyback` undefined).

Run: `npm run test:unit -- quote-buyback.unit.spec`

- [ ] **Step 3: Add the method**

```ts
// service.ts — add imports + method
import { resolveBuybackRate, buybackAmount, type BuybackRate } from "./buyback-rate";
// ...
  // The instant/flat sell-back offer for a pull, composed from the SAME pure
  // helpers the buyback workflow credits with — so the reveal quote and the
  // vault quote and the credit can never disagree. Removes the listPacks +
  // resolveBuybackRate re-query duplicated in the open route and vault route.
  async quoteBuyback(
    packSlug: string,
    rolledAt: Date | string,
    marketValue: number,
    nowMs: number = Date.now()
  ): Promise<{ percent: number; amount: number; rate_type: BuybackRate["rate_type"] }> {
    const [pack] = await this.listPacks({ slug: packSlug }, { take: 1 });
    const { percent, rate_type } = resolveBuybackRate(pack, rolledAt, nowMs);
    return { percent, amount: buybackAmount(marketValue, percent), rate_type };
  }
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Rewire `open/route.ts`** — replace the inline `listPacks` +
      `resolveBuybackRate` + `buybackAmount` block with:

```ts
const packsService = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
const buyback = await packsService.quoteBuyback(
  slug,
  result.pull.rolled_at,
  toMoney(result.card.market_value),
);
// ...
res.json({
  pull: result.pull,
  card: result.card,
  balance: result.balance,
  price: result.price,
  buyback,
});
```

Drop the now-unused `buybackAmount` / `resolveBuybackRate` imports from the
route; add `toMoney`.

- [ ] **Step 6: Rewire `vault/route.ts`** — replace `resolveBuybackRate(pack, …)`

* `buybackAmount(…)` with `await packs.quoteBuyback(p.pack_id, p.rolled_at,
marketValue)`. (Map over pulls already; `quoteBuyback` does one `listPacks` per
  call — acceptable, but if a spec flags N+1, keep the existing `packBySlug` Map
  and the inline pure calls instead and only adopt `quoteBuyback` in the open
  route. Decide by running `vault-buyback` spec timing.)

- [ ] **Step 7: Typecheck + the buyback guard specs**

Run: `npx tsc --noEmit -p tsconfig.json`
Then: `npm run test:integration:http -- pack-open-charge vault-buyback`
Expected: PASS — `buyback {percent, amount, rate_type}` byte-identical to the
baseline commit `35f6d68`.

- [ ] **Step 8: Commit**

```bash
git add backend/packages/api/src/modules/packs/service.ts "backend/packages/api/src/api/store/packs/[slug]/open/route.ts" "backend/packages/api/src/api/store/vault/route.ts" backend/packages/api/src/modules/packs/__tests__/quote-buyback.unit.spec.ts
git commit -m "refactor(packs): fold buyback quoting into quoteBuyback service method"
```

## Wave 1 exit + CHECKPOINT

- [ ] **Full backend verification**

```bash
npm run test:unit
npm run test:integration:http
npm run test:integration:modules
corepack yarn build
```

Expected: all green, build clean. Watch node process count.

- [ ] **STOP — present Wave 1 diff to the user for review before Wave 2.**
      Summarize: helpers added, routes rewired, specs green, zero behavior change.

---

# WAVE 2 — Storefront

> Wave-2 literal call-site edits are finalized at the checkpoint (re-read the
> post-Wave-1 storefront state). Interfaces, schemas, and test code below are
> fixed now; the per-getter substitutions are mechanical against the patterns
> the Wave-1 review confirmed. Commands run from repo root.

## Task 8: zod validated-fetch seam

**Files:**

- Modify: `package.json` (add `zod`)
- Create: `src/lib/data/fetch.ts`, `src/lib/data/schemas.ts`, `src/lib/errors.ts`
- Test: `src/lib/data/__tests__/schemas.test.ts`, `src/lib/__tests__/errors.test.ts`
- Modify: getters in `src/lib/data/*.ts` + `src/lib/actions/*.ts`

- [ ] **Step 1:** `npm install zod` (pin the installed version in package.json).
- [ ] **Step 2 (TDD):** write `schemas.test.ts` asserting each schema parses a
      valid backend fixture and rejects a malformed one (missing `pull_id`, NaN
      `market_value`). Write `errors.test.ts` asserting the consolidated
      `friendlyError` maps each known pattern (already-exists, invalid-credentials,
      rate-limit/429, unauthorized/401, declined) to the same copy the 4 current
      copies emit — gather those strings from `actions/auth.ts`, `actions/customer.ts`,
      `actions/vault.ts`, `actions/packs.ts` first.
- [ ] **Step 3:** implement `fetchValidated(path, schema, opts)` = `sdk.client.fetch`
      then `schema.parse`; `schemas.ts` (one schema per resource: Pack, PackCard,
      VaultItem, WonCard+buyback, LeaderboardRow, Profile); `errors.ts` policy table.
- [ ] **Step 4:** convert getters to `fetch → parse → return`; delete the private
      `interface BackendXxx` + ad-hoc `.filter()` guards; replace the 4 local
      `friendlyError` with the import. **Preserve** the buyback-reveal baseline:
      `actions/packs.ts`'s `buyback` field must keep parsing to `{percent, amount} |
null` with the same finiteness guard (encode it in the WonCard schema).
- [ ] **Step 5:** `npm test` + `npm run typecheck`. Commit.

## Task 9: one `money()` formatter

**Files:**

- Modify: `src/lib/format.ts` (add `money`, delete dead `usd`/`usd0` if unused)
- Modify: `src/lib/packs-format.ts`, `src/lib/data/leaderboard.ts`,
  `src/lib/data/packs.ts`, `src/app/marketplace/MarketplaceClient.tsx`
- Test: `src/lib/__tests__/format.test.ts`

- [ ] **Step 1 (TDD):** `format.test.ts` — assert `money(amount, opts)` reproduces
      every output the 5 current formatters emit (gather exact strings first:
      `usd`/`usd0` from format.ts, `formatValue` "$X.XX", `fmtUsd` "US$X.XX",
      `formatPrice` "$X", local `fmt`). One test per format variant.
- [ ] **Step 2:** implement `money`; point the others at it (delegate) or delete +
      reroute imports. Verify dead exports are truly unused (`grep`) before deleting.
- [ ] **Step 3:** `npm test` + `npm run typecheck`. Commit.

## Task 10: `CardTile` base

**Files:**

- Create: `src/components/CardTile.tsx`
- Modify: `src/app/claw/ClawClient.tsx` (PackCard/PackRow),
  `src/app/marketplace/MarketplaceClient.tsx` (MarketCard),
  `src/components/RecentPullsSection.tsx` (PullCard)

- [ ] **Step 1:** capture the **pre-refactor** visual baseline — build + serve
      standalone on :4000, run the relevant `scripts/*.mjs` capture for claw,
      marketplace, home; save PNGs.
- [ ] **Step 2:** build `CardTile` (frame/aspect/hover/rarity-ring + image/badges/
      footer slots) from the common classes; refactor the three cards to compose it,
      bodies unchanged.
- [ ] **Step 3:** rebuild, recapture, **diff against baseline — must match
      pixel-for-pixel.** `npm run typecheck`. Commit only if the diff is clean.

## Task 11: `Reveal` stagger prop

**Files:**

- Modify: `src/components/Reveal.tsx` (+ `src/lib/use-reveal.ts` if needed)
- Modify: `src/components/HowItWorksSteps.tsx`, `src/components/LeaderboardSection.tsx`

- [ ] **Step 1:** add a `stagger`/`index` prop (or sibling `<RevealList>`) that
      encapsulates the index×delay math. **Do NOT wrap** HowItWorksSteps/
      LeaderboardSection sections in `<Reveal>` — the CLAUDE.md rule stands; they use
      the stagger helper internally.
- [ ] **Step 2:** route both sections' stagger through it; preserve
      reduced-motion (content visible immediately under `prefers-reduced-motion`).
- [ ] **Step 3:** visual capture of how-it-works + leaderboard, diff vs baseline.
      `npm run typecheck`. Commit.

## Wave 2 exit

- [ ] `npm run check` (lint + typecheck + build) clean, `npm test` green, visual
      baselines match, Stop hook green both repos.
- [ ] Invoke `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-review notes

- **Spec coverage:** Candidate 1 → Tasks 2–5; 3-backend → Task 1 (+ wired through
  1–5,7); 2 → Tasks 6–7 (scoped to own-data per Medusa isolation; stock helpers
  intentionally not folded); 4 → Task 8; 3-storefront → Task 9; 5 → Task 10;
  6 → Task 11. All covered.
- **Type consistency:** `toMoney`, `cardByHandle`, `makeRarityOf`, `toCardView`,
  `creditBalance`, `quoteBuyback` named identically across tasks.
- **Known divergence from spec:** "full fold" is bounded — cross-module stock
  helpers stay at the API layer; pure math stays pure. Flagged for the user.
