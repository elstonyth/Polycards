# Lucky Draw — design

Date: 2026-10-24. Status: draft, awaiting operator approval.
Deadline: the whole feature live in production by **2026-11-01 (MYT)**, no phasing
(operator, 2026-10-23).

## Why

The owner wants a monthly Lucky Draw event, first run November 2026 (boss
meeting, 2026-10-23). It gives players a reason to do tasks every day and every
week (tasks pay tickets), and gives the site a visible, exciting prize moment
each month. The prize pool for November is about RM 100k, in cards (PSA slabs
and raw) and credit.

Polycards' brand is hype, premium, **trustworthy** (`PRODUCT.md`). A draw with
RM 100k of prizes lives or dies on players believing it is fair, so every
result is recorded and anyone can look back at who won what.

## What the operator decided

These are the operator's own decisions (chat, 2026-10-23 and 2026-10-24). The
builder must not change them.

1. **Tickets come from tasks.** In admin, every daily, weekly and achievement
   task gets one extra setting: **Tickets: N**. It sits beside the task's normal
   reward (credit, free pack or card). One claim pays both: the normal reward
   plus N tickets.
2. **No cap** on how many tickets a player can earn or put in.
3. **Tickets live in the vault.** The player taps the tickets in the vault,
   "opens" them, and lands on the Lucky Draw page.
4. **Admin configures the prizes** in the backend: what each prize is.
5. **Each prize is its own draw.** On the Lucky Draw page the player chooses
   which prize to put tickets into, and how many. More tickets on a prize =
   higher chance of winning that prize. Chance = my tickets ÷ all tickets on
   that prize.
6. **One spin per prize, one winner.** The winner gets the prize.
7. **Every draw is recorded.** Players can go back and check the history: which
   prize, who won, when.
8. **Monthly.** It runs every month; November is the first.

From the meeting audio (not restated since, treat as wanted unless the
operator says otherwise): each prize shows who has entered and how many tickets
each put in, ranked 1–10.

## Goals

- Admin can set a ticket amount on any task; claiming the task pays the tickets
  in the same claim as the normal reward.
- Players see their ticket balance in the vault and on the Lucky Draw page.
- Admin can create a monthly event with a set of prizes (card from inventory,
  or a credit amount), each with a draw time.
- Players put tickets on the prizes they want, any number, any split.
- At each prize's draw time the server picks one winner, weighted by tickets,
  pays the prize, and records the result permanently.
- Players can browse past results and their own entries.
- Every result can be checked afterwards (see "Fairness").

## Non-goals (v1)

- No buying tickets directly with money or credit. Tickets come only from
  tasks _(my call: keeps this a task reward, not a lottery sale)_ and, since
  2026-10-25, from admin grants (one customer or a whole customer group, like
  credit; ledger reason `admin_grant`, audited). **Changed 2026-10-30:** Lucky
  Packs sell a spin that pays tickets (`2026-10-30-lucky-pack-ticket-spin-design.md`),
  and new events have one winner (`2026-10-30-lucky-draw-one-winner-design.md`).
- No new "More" tab or homepage "Game" section. Those are separate roadmap
  items (nav redesign). v1 entry points are the vault ticket row and the task
  hub; since 2026-10-25 the Games tab's picker links here too.
- No tickets in the Transactions page. Ticket history lives on the Lucky Draw
  page. _(Transactions changes are a separate roadmap item.)_
- No push / email notification to winners. The winner sees the prize in the
  vault and in the history.
- No final art or animation in this spec. Asset slots are listed below; the
  asset plan (Codex image generation) comes next and must land before launch.

## Anti-goals (a failure even if it "works")

- **The browser decides or influences who wins.** The server decides at draw
  time. Any spin animation only replays a result that is already stored.
- **A result changes after the draw**, or a prize is drawn twice, re-rolled, or
  paid twice. A result is final.
- **Tickets spent twice** or a ticket balance below zero.
- **It looks like a casino** (slot machine, flashing coins). `PRODUCT.md` lists
  cheap gacha/casino as an anti-reference. Premium, the card is the hero.
- **A task with tickets silently becomes a free-pack claim.** See "Tickets on
  tasks" for the code trap.

## Words used here

- **Event**: one month's Lucky Draw (name, start, end).
- **Prize**: one item in an event. A card or a credit amount. Each prize has its
  own draw.
- **Ticket**: the currency players earn from tasks and put on prizes.
- **Entry**: tickets a player has put on one prize.
- **Draw**: picking the one winner of one prize.
- **Result**: the stored outcome of a draw.

## Design

### 1. Tickets on tasks

- Add a `tickets` whole number (default 0) to the task definition, **beside**
  the existing `reward`, not inside it. Do **not** add `tickets` as a new member
  of the `TaskReward` union (`modules/packs/tasks.ts`).
  - Reason: `claimTask` (`modules/packs/service.ts`) ends its reward branches
    with a bare `else` that treats anything unknown as a free-pack entitlement.
    A new union member without its own branch would silently become a free
    rip. A separate field avoids that path entirely.
- On claim, tickets are credited **in the same transaction** as the normal
  reward. The claim row's unique `(customer_id, task_id, period_key)` already
  makes a claim happen once, so ticket credit inherits that.
- Record the ticket amount in the claim's `reward_snapshot`, so a later admin
  edit of the task does not change what a past claim paid.
- Task hub (`/task`): show "+N tickets" next to the normal reward on any task
  with tickets. Tapping it goes to `/lucky-draw`. _(My call.)_
- Admin task editor: a "Tickets" number field (0 = none). The task labels used
  by the tasks poster should mention tickets when N > 0.
- No ticket-only tasks in v1: every task keeps its normal reward and tickets
  are an add-on. _(My call.)_ If ticket-only tasks are wanted later, the main
  reward becomes optional and `claimTask` needs an explicit "no main reward"
  branch, never the bare `else`.

### 2. Ticket balance and history

- Each player has a ticket balance plus a ticket history (ledger): earned from
  task X, put on prize Y, refunded from cancelled prize Z.
- The balance can never go below zero. Spending tickets (making an entry)
  locks the player's balance, checks it, writes the entry and the ledger row in
  one transaction. Two taps at once must not spend the same tickets twice.
- Tickets are not tied to an event; one balance carries across events.
  Unused tickets when an event ends **carry over** to next month (Q5, default
  kept by operator 2026-10-24).
- Exact schema (cached balance column vs. sum of ledger) is the builder's call,
  as long as the rules above hold.

### 3. The vault ticket row

- The vault shows tickets as **one row**, e.g. "Lucky Draw Tickets × 52", the
  same way gift packs show as their own row today (`PackGift` row in
  `VaultClient.tsx`). Not one item per ticket, not a `Pull`. _(My call on "one
  stacked row".)_
- Tickets cannot be sold, delivered or showcased.
- Tapping the row "opens" the tickets: a short open animation, then
  `/lucky-draw`. _(Operator: tap → open → Lucky Draw page. The open animation
  is an asset slot.)_
- Shown even at 0 tickets? Builder's call; a 0 row with "Earn tickets from
  tasks" linking to `/task` is a sensible default.

### 4. Events and prizes (admin)

- New admin page: **Lucky Draw**.
  - Create an event: name, start, end (MYT). Status: Draft → Live → Ended, or
    Cancelled.
  - Add prizes to an event. A prize is either:
    - a **card** picked from inventory (PSA slab or raw) — shows the card's
      current value, or
    - a **credit amount** in RM.
  - Each prize has: display title, image (uses the card image by default; credit
    prizes need an uploaded image), display order, and a **draw time** (default:
    the event's end).
  - Publish the event: it goes live on the storefront at its start time.
  - See, per prize: entrants, tickets, and after the draw the result.
  - Cancel a prize before its draw: every entrant's tickets on it are refunded.
  - Withdrawing an event = cancel all its prizes (refunds every entrant; an
    event with no live prize is never shown). A one-click event cancel is
    follow-up work.
- **Card prizes work exactly like today's reward cards** (weekly-challenge and
  task card prizes): admin picks any card, and at the draw the winner gets it
  the same way a challenge winner does. No extra rules for prize cards.
  _(Operator, 2026-10-24.)_
- New admin permissions must be declared in `src/policies`. Undeclared policies
  are soft-deleted on every backend boot (see #692).

### 5. Entering (player)

- `/lucky-draw` lists the live event's prizes. Each prize card shows:
  - art, name, value (RM)
  - draw time with a countdown
  - total tickets in, number of entrants
  - my tickets on it and my chance (%)
  - the entrant list: handle + tickets, ranked, top 10 _(from the audio)_
- The player picks a prize, picks a ticket amount (stepper + "max"), confirms.
- Entries are allowed from the event's start until that prize's draw time.
  After the draw time, entering is refused.
- **Entries are final**: tickets put on a prize cannot be taken back, except by
  an admin cancelling the prize. _(My call.)_
- A player may enter any number of prizes and may win more than one. _(My
  call.)_
- Players must be logged in to enter. Accounts that are frozen or disabled
  cannot enter (existing account gates).
- **Who may enter (Q3, default kept by operator 2026-10-24).** Tickets have no cap and
  daily check-ins can be farmed across many accounts with no phone and no
  top-up (the reason daily-task cards got a sell/delivery lock on 2026-10-23).
  Won prize cards sell back as cash, so farmed accounts could turn check-ins
  into RM 100k of withdrawable value. So **entering needs at least one settled
  real top-up** on the account. The page tells players
  without one to top up first; earning and holding tickets stays open to
  everyone. The existing daily-task lock does not carry over to draw pulls (a
  draw pull has no task claim, and one entry mixes tickets from many tasks),
  so the gate sits at entry instead.
- Errors (not enough tickets, draw closed) are answered in the route itself.
  Medusa's error handler replaces any CONFLICT message with a generic
  idempotency text, so a plain 409 would show the wrong words.

### 6. The draw

- **What starts the draw (Q1, default kept by operator 2026-10-24):
  automatic.** A scheduled job checks every minute and draws each
  prize whose draw time has passed. No admin button decides the moment.
- The draw uses only entries made **before** the draw time. That list of
  entries (handle, tickets) is frozen into the result.
- One result per prize, enforced by a unique index in the database (same idea
  as `challenge_payout`). Running the job twice cannot draw twice.
- If a prize has **no entries** at draw time: no winner, the result says "No
  entries", and nothing is paid. _(My call.)_
- If the winner's account is disabled at draw time, the builder may either
  exclude disabled accounts from the snapshot before drawing (and refund them)
  or treat it as a normal win; excluding is the default. _(My call.)_

### 7. Fairness (checkable results)

_(My call. The minimum — stored seed + frozen entry list — is a must. The public
"verify" explanation can be simple.)_

- When an event is published, each prize gets a secret seed. The page shows
  the seed's SHA-256 hash **before** the draw.
- **The seed is never stored before the draw** (security review, 2026-10-24):
  staff tools and the desk bots can read the database, and anyone who saw a
  seed could time an entry to win. The prize row keeps only a random nonce;
  the seed is HMAC-SHA256 of that nonce under a server secret
  (`LUCKY_DRAW_SEED_SECRET`, an environment variable), derived at publish to
  make the hash and again at the draw. The draw refuses if the derived seed no
  longer matches the published hash. Someone with the production environment
  secret could still predict a draw; that is the operator's own trust boundary.
  A public randomness beacon (e.g. drand) mixed in at the draw would close it
  and is left for later.
- At the draw, the winner is computed from the seed and the frozen entry list
  only: entries in a fixed order (e.g. by entry id), tickets as weights, a
  number derived from the seed (HMAC-SHA256 of seed and prize id, no modulo
  bias) picks the winning ticket. The existing weighted pick (`pickWonRow` in
  `modules/packs/pick.ts`) fits; the existing `secureRoll` does not, because it
  cannot be recomputed later.
- After the draw, the seed is shown in the history. Anyone can hash it to check
  it matches the hash shown before, and recompute the winner from the entry
  list.
- Nobody, admin included, can change a result once written.

### 8. Paying the winner

- **Card prize:** the card goes to the winner's vault as a reward pull, the same
  way weekly-challenge card prizes do (`settleChallengeWinner`: `createPulls`
  with `source: 'reward'`, full bonus basis points). Under the 2026-10-15
  withdrawal rules, reward cards sell back as cash. The existing "no top-up = no
  withdraw/delivery" rule still applies.
- **Credit prize (Q4, default kept by operator 2026-10-24):** **bonus credit**
  (spend on packs, never withdrawable), paid like the weekly
  challenge (`mutateCreditAtomic` with `reward_credit` plus a `WP` ledger row,
  idempotency key per prize). This is the only credit path a job can pay today,
  and it matches the rule "weekly money prize stays bonus". Cash would need a
  new audited payout path.
- Payment happens in the same transaction as the result row, or is retried by
  the job until paid; a prize is never left drawn-but-unpaid.

### 9. History and visibility (player)

`/lucky-draw` has three views (tabs or sections, builder's layout call):

1. **Prizes**: the live event (section 5).
2. **Results**: every past draw, newest first: prize, winner handle, winner's
   tickets / total tickets, entrants, draw time, seed + hash. Tapping a result
   shows the full frozen entry list.
3. **My tickets**: balance, ticket history, my entries and their outcomes.

Handles are the same public handles shown on the leaderboard.

### 10. The spin moment

- When a prize's draw time arrives while the player is on the page, the page
  picks up the stored result (polling is fine) and spins a **prize wheel** that
  lands on the winner. Opening a past result can replay it.
- The spin is decoration only: it is chosen to land on the stored winner.
- Under `prefers-reduced-motion`, show the result directly (house rule:
  `usePrefersReducedMotion`).

**The wheel (operator picked style "K — Holo Foil", 2026-10-24; "too much
gold" — no gold anywhere on it):**

- Front-on wheel: matte black and graphite segments alternating, hair-thin
  silver lines between them, a thin **holographic-foil rim** (soft pale
  cyan/violet/pink shimmer, like a premium card's foil), a pearlescent hub, a
  slim silver pointer at 12 o'clock.
- One segment per entrant, **sized by their tickets**. Names sit along the
  radius on segments wide enough to hold them.
- Motion: a small pull-back, then a fast spin that slows smoothly over about
  7 s and settles; the pointer flicks as each segment edge passes; it stops at
  a random point inside the winner's segment (never dead centre).
- **Win effect (operator picked "Holo dust + prize reveal", 2026-10-24):** fine
  holographic sparkles (a few four-point glints) rise from the winning segment;
  then the wheel dims and the prize card rises out of the hub inside a thin
  holo-foil frame, with a second soft wave of sparkles off the card's top edge;
  winner name and "N of M tickets" appear under it.
- Reference: `docs/superpowers/specs/assets/lucky-draw-spin-prototype.html`
  (throwaway prototype: motion curves, pointer spring, dust, reveal timing).
  The wheel is drawn in code (SVG + CSS); no image file is needed for it.

### 11. Asset slots (placeholders in v1)

The build ships with placeholder art in these slots; Codex art can replace
them before 2026-11-01:

1. Ticket icon (task hub chip, balance display)
2. Vault ticket row art + the "open tickets" animation
3. Lucky Draw page header / hero

The prize frame and the spin/win animation are code (section 10), not art.

## Constraints

- **Base on current `master`.** The branch `fix/vault-prize-no-rarity` is far
  behind (no `topup_myr` task goal). This spec lives on `feat/lucky-draw`, cut
  from `master` at `77babd5c`.
- All times are Malaysia time (MYT, UTC+8).
- Storefront route: server `page.tsx` with metadata, interactive parts in a
  sibling `'use client'` component (house pattern). Follow `DESIGN.md` (pill
  primitives, tokens, `px-fluid`, full-bleed).
- New migrations must be proven in an integration spec (local `db:migrate` is
  gated in auto mode).
- Run the full backend unit suite before calling it green.
- Deploys take about 16 minutes; leave room before 2026-11-01 for a deploy, an
  admin setting up the November event, and a fix round.

## Operator answers (2026-10-24)

1. **Q1 — Draw trigger:** automatic at each prize's draw time (default: event
   end, 30 Nov 23:59 MYT).
2. **Q2 — Prize cards:** work like today's reward cards; no extra rules.
3. **Q3 — Who may enter:** accounts with at least one settled real top-up.
4. **Q4 — Credit prizes:** bonus credit.
5. **Q5 — Unused tickets at event end:** carry over.

## Left to the builder

- Exact tables and columns, as long as the rules above hold.
- Polling interval for the spin moment.
- Admin page layout, following existing admin pages.
- Whether tickets earned before an event starts can be entered once it starts
  (they can: one balance).
