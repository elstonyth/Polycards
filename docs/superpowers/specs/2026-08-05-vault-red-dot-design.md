# Vault tab unread dot — design

**Date:** 2026-08-05
**Status:** approved, ready for planning
**Surface:** storefront app shell (`TabBar`, `AppHeader`) + one new backend read route

---

## What we're building

A small dot on the **Vault** tab that says "something arrived in your vault since
you last looked". It appears on both nav renderings (the mobile `TabBar` and the
desktop `AppHeader` nav, which share `tabs.ts`), and clears the moment the
customer opens `/vault`.

Bare dot, no number. Paper White (`bg-neutral-50`), matching the existing
`NotificationBell` badge. Static — no pulse, no animation.

## What lights it

Exactly two events:

1. **A new pull lands in the vault** — pack open, batch open, or a reward prize.
2. **A delivery order is canceled**, returning its cards to the vault.

## What does not light it

| event | why not |
| --- | --- |
| delivery progress (`requested` → `processed` → `shipped` → `completed`) | Those cards have *left* the vault (`status='delivering'`), and `admin/delivery-orders/notify.ts` already emits a `delivery_status` feed notification. The bell owns that story; duplicating it on the Vault tab would double-signal. |
| a card ships out | Customer-initiated departure. They know. |
| a sell-back | Customer-initiated departure. They know. |

### Scope note

The brief asked for "new pull + delivery status changes". `GET /store/vault`
filters `status: 'vaulted'`, so the vault only ever shows cards that are
*present*. That reduces "delivery status change" to the single transition that
puts a card **back** — a cancel. The other transitions are an `/orders` concern
and are already covered. This is a narrowing of the literal ask, made
deliberately, and it is what lets the whole signal be one query with no schema
change.

---

## Architecture

### The signal — one query, no new columns

```text
latest_event_at = max(pull.updated_at)
                  WHERE customer_id = <from token> AND status = 'vaulted'
```

The `status='vaulted'` predicate is doing all the work. Every event that should
light the dot bumps `updated_at` on a row **inside** the filter; every event that
shouldn't bumps a row that has just left it.

| event | `updated_at` bumps | inside filter | dot |
| --- | --- | --- | --- |
| new pull (pack / batch / reward) | yes | yes | lights |
| delivery canceled → back to vault | yes | yes | lights |
| card ships out (`delivering`) | yes | **no** | silent |
| sell-back (`bought_back`) | yes | **no** | silent |
| `instant_closed_at` stamped on reveal-leave | yes | yes | lights — harmless, coincides with a new pull anyway |
| showcase toggle | yes | yes | **false positive** (see below) |

**Accepted false positive:** toggling showcase on a pull bumps `updated_at`
while `status` stays `vaulted`. Toggled from `/vault` it is cleared by that same
visit; toggled from `/profile/[user]` it lights a dot the customer didn't earn.
One extra tab tap. Removing it costs a dedicated `vault_event_at` column plus
edits to `record-pulls-batch` and the delivery transition workflows — not worth
it for a low-stakes hint. If it ever becomes annoying, that migration is the fix.

### Backend

**New route:** `backend/packages/api/src/api/store/vault/latest/route.ts`

```ts
// GET /store/vault/latest — the newest vault-visible event for the caller.
// Feeds the Vault tab's unread dot: the client compares this against its own
// last-seen stamp. Deliberately NOT part of GET /store/vault — the dot is
// polled from every page, and must not pay for a 500-item vault read.
//
// AUTH: matcher registered in src/api/middlewares.ts with authenticate();
// the customer id comes ONLY from the verified token, so a caller can never
// probe another customer's vault activity.
const [newest] = await packs.listPulls(
  { customer_id: req.auth_context.actor_id, status: 'vaulted' },
  { order: { updated_at: 'DESC' }, take: 1 },
);
res.json({ latest_event_at: newest?.updated_at ?? null });
```

**Middleware:** `src/api/middlewares.ts` gets its **own** entry. The existing
`matcher: '/store/vault'` is exact — that is precisely why
`/store/vault/buyback-batch` already needed a separate one.

```ts
{
  // Vault unread-dot signal (GET /store/vault/latest). Shares the read budget
  // with vault/credits/vip/notifications — it is a one-row indexed read.
  matcher: '/store/vault/latest',
  middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
},
```

No collision with `/store/vault/*/buyback` or `/store/vault/*/showcase` (two
segments vs three).

**No new index.** `IDX_pull_customer_id_rolled_at` seeks on `customer_id`, and
`VAULT_LIMIT` caps a customer at 500 rows, so the residual sort is trivial.

### Last-seen state

`localStorage`, key `polycards.vault_seen_at:<customerId>`, value an ISO string.

**Keyed by customer id, non-negotiable.** `TopUpProvider` carries the scar in a
comment: *"on logout→login as a different account, an untagged balance briefly
leaked the previous user's amount until the new fetch resolved."* An untagged
vault stamp fails the same way — account B inherits account A's cleared dot, or
gets one lit for cards it doesn't own.

`markSeen()` writes the **fetched `latest_event_at`**, not `Date.now()`, so a
pull that lands mid-visit is not swallowed by the clear.

### Data flow

```text
AuthProvider
  └─ TopUpProvider
       └─ VaultDotProvider              ← new, sibling concern
            ├─ fetches on customer change + window focus
            ├─ 30s TTL — skips refetch if the last one was < 30s ago
            ├─ compares latest_event_at vs the localStorage stamp
            └─ exposes { latestAt, show, markSeen }
                 ├─ AppHeader   (desktop nav) → dot on the Vault link
                 ├─ TabBar      (mobile)      → dot on the Vault icon
                 └─ VaultClient               → markSeen()
```

The provider exists because **two** components need the same state; without it
each would fetch independently and double the request cost.

**TTL scope:** the 30s window is an in-memory ref on the provider instance, not
a persisted value. A full page load always fetches; only focus events within a
live session are throttled.

**`markSeen()` timing:** `VaultClient` runs it in an effect keyed on the
provider's `latestAt`, not on bare mount. If the customer reaches `/vault`
before the fetch resolves, `latestAt` is still `null`, `markSeen()` is a no-op,
and it fires for real the moment the value arrives. Keying on `latestAt` also
means a pull landing during the visit clears itself on the next focus refresh
rather than leaving a dot behind for cards the customer is looking at.

### Request cost

Adds ~1 request per navigation for signed-in customers, alongside
`NotificationBell`'s existing one. The shared `storeReadRateLimit` budget is
480/60s (burst 120/10s) and, per its own comment, "one account-page RSC render
fans out to ~6-8 of these reads" — so this is a ~12-15% increase, well inside
headroom. The 30s TTL exists specifically so rapid tab-switching cannot recreate
the 2026-07-07 sustained-ceiling incident. Signed out: the provider never
fetches.

---

## Files

### Backend (2)

| file | change |
| --- | --- |
| `backend/packages/api/src/api/store/vault/latest/route.ts` | new, ~20 lines |
| `backend/packages/api/src/api/middlewares.ts` | +1 matcher entry |

### Storefront (8)

| file | change |
| --- | --- |
| `src/lib/vault-dot.ts` | new — pure logic: `seenKey(customerId)`, `shouldShowDot(latestAt, seenAt)`. No React, no I/O. The only branching code, therefore the only unit-tested code. |
| `src/lib/data/schemas.ts` | `+VaultLatestSchema` |
| `src/lib/actions/vault.ts` | `+getVaultLatest(): Promise<string \| null>` — same degrade-to-null contract as the neighbouring `getCreditBalance` |
| `src/components/app-shell/VaultDotProvider.tsx` | new, ~70 lines — identity-tagged state, mirrors `TopUpProvider` |
| `src/app/layout.tsx` | wrap, inside `TopUpProvider` |
| `src/components/app-shell/TabBar.tsx` | dot span on the Vault icon |
| `src/components/app-shell/AppHeader.tsx` | dot span on the desktop Vault link |
| `src/app/(account)/vault/VaultClient.tsx` | `markSeen()` in a mount effect |

Untouched: `VaultActionBar`, `vault-map.ts`, the `pull` model, every workflow,
and every migration.

---

## Visual + accessibility

- **Color:** `bg-neutral-50` (Paper White), the same token as the
  `NotificationBell` badge. `DESIGN.md:143` reserves Alarm Red for "errors and
  destructive confirmation only" and `DESIGN.md:157`'s Signal Rule requires a
  non-neutral color to name a tier, a rarity, money in, or danger. New cards are
  none of those, so the dot stays neutral. "Red dot" is used here as the generic
  name for the pattern, not as a color instruction.
- **Size / position:** 8px circle (`h-2 w-2`), absolutely positioned.
  - `TabBar`: top-right of the icon, inside the icon's bounding box, so it never
    collides with the 10px label beneath.
  - `AppHeader`: top-right of the icon inside the nav pill — on the icon, not the
    pill corner, so it reads as belonging to Vault rather than floating between
    nav items.
- **Active-state inversion:** the desktop nav's active pill is
  `bg-neutral-50 text-neutral-950`, so a Paper White dot would vanish on it. When
  the Vault link is active the dot renders `bg-neutral-950` instead. Normally
  moot (being on `/vault` clears the dot), but reachable: a pull can land while
  the customer is sitting on the page, and the next focus refresh relights it.
  `TabBar`'s active state only changes the icon color, so it needs no inversion.
- **Motion:** none. No pulse, no fade-in. `DESIGN.md:121` explicitly rejects
  "cheap gacha/casino neon"; a blinking nav dot is that.
- **Screen readers:** a color-only signal is invisible to them. The dot span is
  `aria-hidden`, and the Vault link takes an `aria-label` of `"Vault, new items"`
  when `show` is true (plain `"Vault"` otherwise) — the same technique
  `NotificationBell` uses for its count.

---

## Failure modes

| condition | behavior |
| --- | --- |
| fetch fails / 401 / 429 | `latest_event_at` resolves `null` → dot hidden. Never show a dot we can't justify; the cards are still there on the next visit. |
| `localStorage` throws (Safari private mode) | try/catch, treated as "no stamp" → dot shows. Degrades toward *showing*, the harmless direction. |
| SSR | provider holds `show=false` until mounted. `localStorage` does not exist server-side; rendering the dot before mount is a hydration mismatch. |
| first ship | every existing customer with a vault gets one dot (no stamp yet). Correct, and self-clearing on first visit. |
| stale stamp ahead of `latest_event_at` (clock skew) | no dot. The comparison is `>`, not `!==`. |
| logout → login as a different account | different `seenKey`; the provider drops state on `customer.id` change. |
| signed out | Vault tab is `gated: true` (opens the signup modal); provider never fetches, dot never renders. |

---

## Tests

| test | covers |
| --- | --- |
| `src/lib/__tests__/vault-dot.test.ts` | table over `shouldShowDot`: no stamp + latest → true; equal → false; stamp older → true; stamp newer → false; `latest` null → false; malformed stamp → true. Plus `seenKey` includes the customer id. |
| `backend/.../api/store/vault/latest/__tests__/route.unit.spec.ts` | customer id read from `auth_context` only; `status: 'vaulted'` filter present; `order: { updated_at: 'DESC' }, take: 1`; `null` on an empty vault. |
| `backend/packages/api/integration-tests/http/vault-latest.spec.ts` | 401 unauthenticated; newest row wins; **IDOR — customer B's pull never appears for customer A**. |

**No new E2E, deliberately.** The rendered output is two `<span>`s and the logic
is fully unit-covered. `.claude/rules/common/testing.md` scopes the coverage
target to "units that encode behavior" and explicitly warns against "brittle
markup assertions for presentational components". Flagged here rather than
silently skipped.

---

## Deliberately not built

- **Cross-device sync.** Clearing the dot on your phone leaves it lit on desktop
  until you visit there too. Upgrade path if it matters: move the stamp to
  `customer.metadata.vault_seen_at` — same read route, swap the storage in
  `VaultDotProvider`, add a write action. Nothing here forecloses it.
- **A count.** Bare dot only.
- **Per-item "New" markers inside `/vault`.** The dot answers "is there anything
  new"; it does not answer "which ones".
- **A generic per-tab badge system.** Vault is the only tab that needs one. If
  Task or Ranks ever want one, generalize then.
- **Removing the showcase-toggle false positive.** See the accepted-false-positive
  note above.
