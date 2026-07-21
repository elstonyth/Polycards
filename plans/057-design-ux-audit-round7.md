# Round 7 — Design / UX audit (storefront only)

Date: 2026-07-22. Base commit: `a15f88e1`. Method: four parallel read-only
audits (global tokens + shell, home/marketing, conversion funnel, account
cluster), findings re-verified against the live code before ranking.

Scope note: rounds 1-6 (plans 001-056) swept money, security, and backend
correctness. This round deliberately covers only what those missed — the
design system, the shipped UI, and user-facing copy truth. No overlap.

Every item below is grounded at a file:line. Nothing here has been fixed.

---

## Tier 1 — ship first

### 1. ~~The body font is not loading~~ — RETRACTED, THIS FINDING WAS WRONG

**Correction (2026-07-22, from code review):** the premise is false. Current
`next/font/google` registers the REAL family name, not a hashed one. The built
CSS emits `@font-face{font-family:Geist}` and `@font-face{font-family:Geist
Fallback}` (verified in `.next/static/css/*.css`), so the old literal
`--font-sans: 'Geist', 'Geist Fallback', ...` resolved correctly all along.
**Body copy was never falling back to system-ui.**

What shipped is behaviour-neutral: `var(--font-geist-sans)` resolves to those
same two families, and is marginally more robust to a future font swap. The
`--font-mono` half of the change WAS correct - no Geist Mono face is emitted
anywhere (layout.tsx never imports it), so those two literals really were dead
and now degrade honestly to `ui-monospace`.

Process note worth keeping: this finding shipped with the instruction "expect
the whole app to visibly change - screenshot before/after." Nothing visibly
changed, and no one noticed until review, because the screenshot step was never
performed. A claim of a global visual regression must be confirmed by looking
at the rendered page before it is written down as fact.

Original text follows for the record.

### 1 (original, retracted). The body font is not loading (`src/app/globals.css:10`)

`layout.tsx:15` declares `variable: '--font-geist-sans'` and puts it on
`<html>`. Nothing reads it. `globals.css:10` instead hardcodes the literal
family `'Geist', 'Geist Fallback'`, and the `geist` npm package is not in
`package.json` — so no plain `Geist` family is registered. `next/font/google`
emits a hashed family name reachable only via the CSS var. Body copy across
the entire app therefore falls through to `ui-sans-serif` / `system-ui`.
Nekst is wired correctly (`globals.css:13` reads `var(--font-nekst)`); the
asymmetry is the tell.

Fix: `--font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;`
One line. Expect the whole app to visibly change — screenshot before/after.

### 2. Buyback rate is stated three different ways

- `/about` says a flat **85%**, three times (`about/page.tsx:44,64,66`)
- `/how-it-works`, `StepInfoPill`, `HowItWorksSteps` say **85-90%**
- `HowItRips`, `FinalCta`, `layout.tsx:34`, `SiteFooter:39` say **up to 90%**

A user reading two pages sees two different guarantees on the core money
promise. Fix: one exported constant, one string, every surface reads it.

### 3. The fairness mechanism contradicts itself

`HowItWorksSteps.tsx:33` claims pulls are "powered by public VRF".
`fairness/page.tsx:37-41` and `how-it-works/page.tsx:123` both describe
commit-reveal (serverSeedHash / revealed serverSeed / clientSeed). These are
different systems, and the VRF card renders on the same page as the FAQ that
contradicts it. Commit-reveal is the majority and matches the fairness page.

Fix: delete "powered by public VRF".

Related: `fairness/page.tsx:37` is future tense ("**will** list the selection
proofs for your last 100 pulls") while `how-it-works:123` claims present-tense
that "every result can be independently checked". Soften the FAQ until proof
publishing ships, and drop the invented "100" cap.

### 4. A transport failure can freeze the spin screen after a charge

`SlotMachineClient.tsx:366` — `const res = await openBatch(...)` sits outside
the `try` that starts at `:399`.

Verified caveat: `openBatch` (`lib/actions/packs.ts:239`) has its own
try/catch and returns `{ok:false}` for backend failures, so the common paths
are handled. What escapes is a rejection of the Server Action RPC itself —
offline, action endpoint 5xx, deployment-ID mismatch. On that rejection
`phase` stays `'resolving'` forever, `spinGuarded` (`:267`) permanently
disables Spin, and nothing renders. The settle watchdog (`:599-608`) is gated
on `phase === 'spinning'` so it cannot rescue this; `error.tsx` cannot either
(event-handler rejection, not a render error). Charge state is indeterminate.

Fix: wrap the await; on catch, set an error and return `phase` to `'idle'`.

### 5. Fabricated live status on /contact

`contact/page.tsx:16-30` — `VAULTS` is a hardcoded array, all three entries
`status: 'Operational', ok: true`, rendered at `:92-94` with `animate-ping`
and buyback-green: the visual vocabulary of a real health feed that can never
show degradation. Fix: wire a real endpoint, or drop the pulsing dot and
relabel the panel as processing times, which is all the `note` field is.

### 6. Referrals dead-ends users who have no handle

`referrals/page.tsx:49-54` tells a handle-less user to "Set a profile handle
in Settings" and links `/settings`. No handle field exists there
(`SettingsForm.tsx:58-97` is first/last name + phone + read-only email) and no
handle-setting UI exists anywhere in the repo. That user is permanently locked
out of their invite link. Fix: ship the field, or write the real path.

---

## Tier 2 — systemic, one fix closes a class

### 7. No loading or error boundaries anywhere except the root

Only `src/app/error.tsx` and `global-error.tsx` exist. No `loading.tsx` at
all. Consequences:

- All 11 account pages await network server actions with no fallback
  (`me/page.tsx:59-69` awaits five in parallel, then a sixth serially)
- The funnel is worse: all three slots routes are `force-dynamic` and await
  2-3 backend reads before the first byte, so the "Open Pack" tap
  (`PackDetailClient.tsx:130`) blocks with zero feedback at the exact
  conversion moment. The CTA looks dead.

Fix: one `(account)/loading.tsx` + `(account)/error.tsx` covers all 11 pages.
Three `loading.tsx` under slots; the spin one should be the dark room plus a
static reel frame so the transition does not flash.

### 8. Design tokens are documented but not implemented

`DESIGN.md` describes a system the code cannot enforce:

- **12 of 15 colors have no CSS var.** Only `--color-chase`, `--color-buyback`,
  `--color-buyback-fg` exist (`globals.css:17,23,24`). Everything else is a
  raw `neutral-*` guess that happens to coincide — `border-white/10` alone
  appears 158 times.
- **Radius is off ~40% at every step.** Doc says sm 8 / md 12 / lg 16px;
  `--radius: 0.625rem` yields 6 / 8 / 10. This is why 225 ad-hoc
  `rounded-xl` / `rounded-2xl` exist — they are the only way to reach 16px.
- **The spacing scale has zero implementation** (`xl: 40px` is not even a
  Tailwind name).
- **The five type roles are prose only.** No `--text-display`, no
  `.type-label`; every heading re-types `text-[15px] font-heading leading-none`.
- **24 undocumented vars**: the full shadcn oklch set, including a `:root`
  light block that is dead code (`layout.tsx:73` hardcodes `dark`, no toggle).
- DESIGN.md contradicts itself on buyback green (`:13` `#10834a` vs `:142`
  `#118c4f`; code follows the frontmatter).

Fix: emit the color + radius + type tokens into `@theme`, delete the spacing
block or implement it, delete the dead light block. Then the palette is
grep-enforceable and the ad-hoc radius sprawl has a target to collapse into.

### 9. Two of three UI primitives do not exist

`src/components/ui/` holds exactly `pill.tsx` and `SuccessToast.tsx`. There is
no Card and no Input primitive. `<input>` is hand-rolled **30 times across 11
files**; the charcoal-card recipe is retyped 100+ times.

Pill itself is genuinely adopted (21 importers, 28 call sites) — the pattern
works, it just was not finished. One real bypass: `AppHeader.tsx:73`
re-implements the primary pill by hand and consequently ships no
focus-visible ring, the exact thing `pillVariants` exists to guarantee.

DESIGN.md `:206-209` already specifies the input; build to it.

### 10. Focus rings fail contrast on most forms

`AddressesClient.tsx:15`, `rewards/WithdrawForm.tsx:10`, `OrdersClient.tsx:62`,
`SettingsForm.tsx:92,133` all use `focus:outline-none` with nothing but
`focus:border-white/25` — a 1px 25%-alpha edge on `bg-white/[0.03]` over
near-black, well under the 3:1 required by WCAG 2.4.11. `AuthForm.tsx:360`
and `ResetPasswordClient.tsx:134,149` do it correctly with
`focus-visible:ring-2 focus-visible:ring-white/40`.

Fix: hoist the AuthForm ring into the shared input class (folds into #9).

Adjacent: `SkipLink.tsx:7` focuses to `z-50` — the same level as the sticky
header, which paints later in DOM order and covers it. The first tab stop on
every page renders behind the chrome bar. `focus:z-[60]`.

### 11. Rarity blue fails AA on the most important number in the product

`lib/rarity.ts:13` — `Rare: '37, 99, 235'` (blue-600) as foreground on the
near-black shell is ~3.5:1, under the 4.5:1 floor, and the `rgba(rgb,0.12)`
pill background lowers it further. It renders the `{rarity} · {value}` pill in
`SlabCard.tsx:224-232`, `CardDetail.tsx:131-141`, `RouletteClient.tsx:96-109`.

Fix: a `RARITY_TEXT_RGB` map (blue-400 `96,165,250` for Rare) for text/pills;
keep `RARITY_RGB` for glows and fills.

Good news, verified: `silver-text #a3a3a3` passes AA everywhere (7.85:1 on
ink, 7.11:1 on charcoal, 6.00:1 on graphite). The `#737373` that DESIGN.md
`:191,213` prescribes for disabled/inactive would **fail** (4.18:1) and
contradicts its own `:155,267` ("never below silver") — the code correctly
ignores it (0 occurrences). Fix the doc, not the code.

### 12. Reduced motion has no global backstop

**Partial correction:** the claim that `VaultRoom.tsx:46,118,141` are ungated is
WRONG. All three sit behind `!reduced`, sourced from `usePrefersReducedMotion()`
in `SlotMachineClient.tsx` and threaded through `RevealStage`; under reduced
motion the dust and burst layers are not even rendered. The missing global CSS
backstop was real and has shipped; the clack-scheduler half below was also real.

The only `prefers-reduced-motion` block in CSS (`globals.css:549`) scopes to
three `.challenge-*` classes. Most call sites use `motion-safe:` /
`motion-reduce:` correctly, but three are ungated: `VaultRoom.tsx:46,118,141`.
Worse, `SlotMachineClient.tsx:627-644` schedules per-column stop clacks up to
~5.6s unconditionally, while `ReelStrip.tsx:249-252` finishes instantly under
reduced motion — so that user sees the card land, then hears reel-stop audio
fire over a static screen for seconds.

Fix: a 6-line global reduce block closes the CSS class permanently; add
`|| reduced` to the clack scheduler guard.

---

## Tier 3 — real, lower blast radius

13. **Fake-precise stats with no disclaimer.** `demo-stats.ts:5-7` renders
    `1.9M` transactions / `RM 167.9M` volume / `19.8K` listings in the
    how-it-works hero. The file comment admits they are placeholders; nothing
    user-facing does. The decimal precision is what sells them as telemetry.
    Same on `/about`: `520K+` units, `5+` partners, `5+` card categories —
    and that last one contradicts the Pokémon-only storefront that
    `how-it-works:99` describes. The irony: `how-it-works:93` carries the
    comment "Don't advertise what isn't there."

14. **/social is a stub with live-looking links.** `SocialClient.tsx:25,60`
    renders `MOCK_USERS` (75 lines of invented handles), each linking to a
    working `/profile/<mock>`. The only disclaimer is 11px at `text-white/55`
    below a 3-col grid — off-screen on mobile.

15. **/roulette always yields the same card.** `RouletteClient.tsx:66,130`
    hard-codes `strip[WIN_INDEX]`, under a rendered "Legendary 1% / Rare 9% /
    Uncommon 90%" odds row (`:19-23`). Not linked from any nav, which is the
    only reason this is not Tier 1. Delete the route or randomize it and drop
    the odds display.

16. **Six FAQ shortcuts that all no-op.** `contact/page.tsx:125-137` — all six
    link to `/how-it-works`, and none of the six questions is answered there.

17. **Duplicate CTA intent, four instances.** `about:156/342` (`Explore Packs`
    vs `For Collectors`, both → `/slots`) and `about:167/353` (`Launch With Us`
    vs `For Brands`); `how-it-works:192/439` (`Start Opening Packs` vs `Open
Your First Pack`). `TierShelf.tsx:28-37` names a _heading_ `RIP A PACK`,
    the same string as the hero's primary button, beside an `All packs →` link
    over rows that each say `Rip it →` — four ways to say one thing in 200px.

18. **Price is derived from a display string.** `lib/data/packs.ts:51-52`
    rounds to a 0-decimal string; `packs-data.ts:124` re-parses that string
    into the number driving `cost * reels`, the Bet meter, `canAfford`, and
    the shortfall math. Today's packs are whole RM so nothing fires. The first
    pack priced RM 1.50 shows "RM 2", gates affordability at 2, charges 1.50.

19. **Money formatting disagrees with itself for the same number.**
    `me/page.tsx:288` shows the wallet balance as `rm(...)` → "RM 150.00";
    `vault/VaultClient.tsx:282` shows the identical `providerBalance` as
    `rm0(...)` → "RM 150". Also `pack.price` renders raw at `CatalogClient:86,191`
    and `PackDetailClient:330` while everything else goes through `rm`/`rm0`.

20. **Layout-family repetition on the two long marketing pages.** `/about`
    sections 2, 3 and 5 are the same icon-card grid (2 and 3 are byte-identical
    grid dims, and consecutive). `/how-it-works` runs grid-grid-grid at 4-5-6;
    §4 and §6 are deliberately differentiated in the code, but the testimonial
    grid between them re-establishes the rhyme. `SectionHeading` is duplicated
    verbatim across both pages (`about:101` / `how-it-works:135`), as is the
    closing CTA panel class string.

21. **Three mobile grids with no `grid-cols-1` base.** `how-it-works:231`
    (a 3-col stats bar rendering `RM 167.9M` at `text-xl` in a ~110px column
    at 360px) and `:291` (`grid-cols-2 … lg:grid-cols-4`). The hero at
    `:162-246` also stacks a `h-[280px]` pack fan plus that stats bar below
    the CTA — two screens of scroll before section 2.

22. **Home has no `<h1>` in the hero.** `HeroBoard.tsx:74` is a `<p>`, and
    `aria-labelledby="hero-heading"` (`:38`) points at the 11px eyebrow. The
    page's only `<h1>` is `TierShelf.tsx:28`, a section heading.

23. **Account page-shell drift.** 6 of 11 pages use `AccountHeader`; `vault`,
    `referrals` and `addresses` rolled their own — with ALL-CAPS titles
    ("VAULT", "INVITE FRIENDS") against the sentence-case rest of the cluster.
    `me/page.tsx` has no page title at all. Two card materials also coexist:
    `Panel` (`account/ui.tsx:27`, `bg-white/[0.03]`) vs `bg-neutral-900` in
    vault/referrals/me/addresses — visible when navigating `/me` → `/wallet`.

24. **Empty-state census.** Composed (icon + heading + CTA): `orders:13`,
    `notifications:86`, `vault:378,393`. Headline only: `transactions:55`.
    Bare one-liner: `addresses:150`, `referrals:93`, `me:261`. None at all:
    `wallet`, `vip`, `settings`. `addresses:150` is also a dead branch — `:37`
    opens the form whenever the list is empty, so it never renders.

25. **Six shipping-address inputs, none `required`.** `WithdrawForm.tsx:80-162`
    posts empty strings and waits for a server 400 (`:164`). Same in
    `AddressesClient.tsx:165-181` (seven fields). The address form now exists
    in **four** copies (`AddressesClient:76`, `WithdrawForm:76`,
    `OrdersClient` EditAddressModal `:106`, `RequestDeliveryModal`) with three
    copies of the same `INPUT_CLASS` and already-drifted labels ("Country code"
    vs "Country code (2 letters)"; WithdrawForm drops phone and line-2).

26. **Placeholder-as-label on the highest-stakes form.** `AuthForm.tsx:137-271`
    (email / password / username / confirm password) has no visible labels;
    `Field` at `:358` fakes it with `aria-label={props.placeholder}`. Same in
    `ResetPasswordClient.tsx:129,146`. Every other form in the app labels
    above the input. Worst on "Confirm password", where the hint vanishes on
    first keystroke.

27. **Orders table: 6 columns, unpaginated, no mobile layout.**
    `OrdersClient.tsx:461-567` — every row `whitespace-nowrap`, 48px proof
    thumbnails nested in a cell, two 30px-tall buttons adjacent in the actions
    cell where a mis-tap cancels a shipment. Only affordance is
    `overflow-x-auto`. Transactions and notifications both paginate; this
    does not.

28. **Tap targets under 44px.** `notifications:129` mark-all (~30px);
    `orders:545-559` both action buttons (~30px, adjacent);
    `addresses:196-203` bare-text Cancel; `vault:311,324` rarity chips (32px);
    `QtyStepper:286,298` (28px) and `PackDetailClient:590,601` (40px wide).
    All clear WCAG 2.2 AA SC 2.5.8's 24px floor — this is ergonomics, not
    conformance — but the codebase already knows better (`NotificationBell:35`
    and `ReferralsClient:50` are `h-11 w-11`).

29. **Three hand-rolled quantity steppers in the funnel.**
    `PackDetailClient:340-368`, `:584-605`, and `components/QtyStepper.tsx` —
    all clamping to `[1,3]`, all different markup, and only two of six buttons
    get a `disabled`. Both `+` buttons stay opaque and enabled at qty 3 while
    doing nothing. `QtyStepper` already takes a `max`. Also: the desktop
    catalog card has a stepper and passes `?count=qty`; the mobile `PackRow`
    (`CatalogClient:207`) hard-codes `1`, so phone users cannot set quantity
    in the catalog at all.

30. **The shortfall notice is written three times and has drifted.**
    `PackDetailClient:396,621` open the top-up sheet via `useTopUp`;
    `SlotMachineClient:909` instead navigates to `/vault`. Same condition,
    two different resolutions.

31. **Reveal skip is pointer-only in one phase.** `RevealStage.tsx:321` is
    `onPointerDown` on a plain `<div>` — no keyboard, no role, no label —
    while the flood-phase skip directly above (`:133-141`) is a proper button
    with `aria-label`. Same gesture, operable in one beat and dead in the next.
    Related: when `phase` flips to `'review'` focus is never moved to the card
    (`:262`), leaving keyboard focus on the now-disabled Spin button.

32. **`'resolving'` has no visual.** `SlotMachineClient.tsx:363` — `winners`
    is still null so the reel stays in idle drift, `aria-busy` is only set for
    `'spinning'` (`:726`), and the button reads "Spinning…" while nothing
    spins. The network RTT sits _before_ the animation instead of inside it.

33. **A transient backend error renders as a hard 404.**
    `card/[handle]/page.tsx:48` — `getCard` swallows every failure and returns
    `null` (`lib/data/cards.ts:36-39`), so an outage tells a user that the
    card they own does not exist. Same shape at `vouchers/page.tsx:29-34`,
    where `dailyResult.ok === false` coerces to `[]` and a user with claimable
    vouchers is shown "No Active Vouchers".

34. **Notifications refetch failure is silent.** `NotificationsClient.tsx:42-50`
    refetches on mount (correctly, and well-commented) but `if (live && r.ok)`
    discards a failure with no signal, and there is no pending indicator
    during the swap. `notifications/page.tsx` also lacks the
    `export const dynamic = 'force-dynamic'` that orders and settings set.
    `NotificationBell.tsx:20-22` maps any fetch error to `setCount(0)` — the
    badge reads "no unread" on backend failure.

35. **Settings is half fake.** `settings/page.tsx:14-18,47-64` — `UPCOMING`
    renders three "Coming soon" pills filling the entire right column of a
    2-col grid, against three real name/phone fields on the left.

36. **Dead code in the shared account kit, one of it a lie.**
    `account/ui.tsx:59-98,178-184` — `MockTable` and `DemoNote` are exported
    and imported nowhere. `DemoNote` renders "Demo only — this account area
    connects to the backend in a later phase." One stray import from telling a
    customer their wallet is a mock. Delete both.

37. **Address book is add-only.** `AddressesClient.tsx:26-30,121-147` — no
    edit, no delete, no default. A typo'd postal code is permanent and the
    list grows forever, while `OrdersClient.tsx:87-163` lets the user change
    an order's destination. Two mental models for one dataset.

38. **34 raw `<img>` across 18 files** vs 13 files on `next/image`. Highest
    traffic: `AppHeader.tsx:41`, the logo on every page, with an eslint-disable
    and no `priority`. Clusters in `HowItWorksSteps.tsx` (5) and
    `how-it-works/page.tsx` (5).

39. **Em-dashes in shipped UI copy.** 990 in `src/` total, 179 on non-comment
    lines. Worst user-facing: `wallet/page.tsx` (13), `PackDetailClient` (7),
    `TopUpSheet` (6), `RevealStage` (5), `WeeklyChallenge` (5). The raw-count
    leaders (`schemas.ts` 51, `SlotMachineClient` 49) are comment prose.

40. **z-index has 14 levels, 9 arbitrary.** `z-50`(9), `z-40`(4), `z-[100]`(4),
    `z-[2]`(4), `z-[70]`(2), `z-[1]`(2), plus `z-[80]/[110]/[120]/[130]/[3]`.
    Header, TabBar and CookieConsent all share `z-50`; only DOM order
    separates them. Five named `--z-*` vars would cover every real case.

41. **`/task` is a placeholder holding a permanent bottom-nav slot**
    (`task/page.tsx:296`). Already `robots: {index:false}`, so the intent is
    acknowledged — hide the tab until there is a task list.

42. **`demo-stats.ts:1-3` cites a `/activity` route that does not exist.**

---

## What is already good (verified, do not "fix")

- **Zero `'use client'` across all 33 `page.tsx` files.** Every route is a
  server component delegating to a `*Client.tsx`. Cleanest thing in the audit.
- **Zero `window` scroll listeners** anywhere in `src/`. All reveal work is
  IntersectionObserver (`lib/use-reveal.ts:44-50`, `useSyncExternalStore`,
  SSR-safe). `HeroVideo.tsx:24-26` even pauses post-hydration.
- **No div-based fake card art** in the funnel — `CardTile`, `CardDetail`,
  `SlabCard`, `SellConfirmModal` and the pulls ticker all render the real
  `SlabImage` with `rarity` passed for the tier frame.
- **Eyebrow discipline holds.** Only 4 true section eyebrows across all
  marketing pages; the rest of the `uppercase tracking-*` hits are in-card
  status labels.
- **Home section rhythm is varied** — 7 sections, zero repeated layout family.
- **App-shell contract is disciplined**: safe-area insets on TabBar,
  CookieConsent correctly stacked above it, desktop nav single-line.
- **Sell-back is properly guarded** — `SellConfirmModal` has a focus trap,
  Escape, and permanence copy; the 30s offer expiry degrades to "vaulted,
  sell anytime" rather than a loss.
- **`silver-text` passes AA on every documented surface.**

---

## Suggested execution order

Tier 1 items 1-6 are independent and small; ship them as one PR each or one
bundle. Then #7 (boundaries) and #8 (tokens), because #8 unblocks #9/#10/#11
and collapses the ad-hoc radius sprawl. Tier 3 is a grab-bag — the highest
value/effort ratios in it are #18 (price string), #19 (money format), #25/#26
(forms, which fold into #9), and #33 (404 on transient error).

---

## Review corrections (2026-07-22)

Two independent reviewers (one broad, one adversarial on the money path) went
over commit `65c94af1`. What they changed about this document:

**Retracted outright:**
- Finding #1 (body font not loading). False premise; see the note inline. The
  shipped change is harmless but fixed nothing user-visible.
- Half of finding #12 (VaultRoom animations ungated). They were already gated.

**Found by review, not by the audit** - a real regression the fix introduced:
- The new transport catch in `SlotMachineClient` re-enabled Spin without
  refetching the balance. Since the failure it exists for is precisely the one
  where the server DID charge but the response never came back, the player
  would see a stale pre-charge figure, follow the "check your balance" copy,
  conclude the spin was free, and spin again. The fix traded a permanent freeze
  for a double-charge window. Now refetches before re-enabling, and does the
  same on the `{ok:false}` path, which `openBatch` can also return after a
  charge has landed (an enrichment failure maps to "please try again").
- `rm0(priceNum * qty)` on both buy CTAs under-displayed a non-integer charge
  in both directions (RM 1.40 rendered "RM 1"), and contradicted the `rm()`
  fine print two lines below it. Now `rm()`.

**Confirmed sound under attack** (recorded so the next round does not re-audit):
90% is a genuine floor on every sell path - `resolveBuybackRate` is the single
source, admin validation rejects a per-pack rate below it, `UNQUOTED_BUYBACK` is
keep-only, FX and the market multiplier scale the value not the percentage, and
no fee is deducted. `res` has no use-before-assign hole; the catch leaves no
wedged state; the settle watchdog and account-switch guard are unaffected;
`priceValue` is populated at every construction site and non-finite prices are
dropped by the schema before they can reach arithmetic.

**Still open after this pass:**
- `required` reached 2 of the 4 address forms. The other two
  (`OrdersClient.EditAddressModal`, `RequestDeliveryModal`) are not wrapped in a
  `<form>`, so `required` would be inert there - the real fix is the single
  `<AddressFields>` component finding #25 asks for, which is the natural next PR.
- Finding #32 (the `resolving` phase has no visual) is only half closed:
  `aria-busy` now covers it, but a sighted user still reads "Spinning..." over a
  static reel.
- Entering the account group from outside still blocks on the layout's own
  `await getCustomer()`, which sits outside the Suspense boundary.
