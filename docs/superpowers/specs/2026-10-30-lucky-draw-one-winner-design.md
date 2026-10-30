# Lucky Draw: one winner per event — design

Draft, 2026-10-30. Changes the rules in `2026-10-24-lucky-draw-design.md`, which
stays the source for anything not mentioned here (tickets on tasks, the ticket
ledger, fairness, paying a winner).

## What the operator decided

- An event is time-based: admin sets a start time, an end time and its prizes
  (credit, cards or slabs).
- Customers put tickets on **the event**, not on a single prize.
- When the event ends, **one customer wins everything** in that event.
- Then the next event runs the same way.
- Confirmed on 2026-10-30 (playback accepted):
  - More tickets means a better chance, and one ticket can still win.
  - Customers can add tickets until the end time. Entries are final, and losing
    tickets are gone.
  - Tickets not put in carry over to the next event.
  - Only one event runs at a time. Admin can set up the next ones ahead, and the
    page shows "Coming soon" if there's a gap.
  - Prizes lock once the event starts.
  - If nobody enters, there's no winner and no prizes go out.
  - Results stay checkable after the draw, like today.
  - Events already published finish under the old rules. Only new events use one
    winner.

## Non-goals

- Changing how tickets are earned, or the ticket ledger's meaning.
- Admin picking the winner, or a button that starts the draw. The job still decides
  the moment.
- A one-click migration of old events to the new rules.

## Anti-goals

Everything in the Lucky Draw spec still applies, plus:

- Part of an event's prizes paid and the rest lost.
- An event drawn twice, or a result that changes.
- Two events live at once, or a running event hidden by another (this happened
  locally on 2026-10-30: a fully drawn event hid a live one).
- Tickets accepted after the end time.

## Design

### 1. Data

- `lucky_draw_event.draw_mode`: `one_winner` for every new event, `per_prize` for
  rows that exist today. Old events keep their current code path until they finish.
- The event gets its own seed, the same way a prize has one today: `seed_nonce` and
  `seed_hash` written at publish, and the seed itself first written at the draw. The
  rules in section 7 of the Lucky Draw spec are unchanged, with the event id in place
  of the prize id. Prize rows of a `one_winner` event keep null seed fields.
- Entries point at the event. `lucky_draw_entry` gains `event_id`, and `prize_id`
  becomes nullable, with a CHECK that exactly one is set.
- One draw per event, enforced by a unique index on the event's result row. The
  entries list and seed are frozen there, the same way `lucky_draw_result` does it per
  prize.
- A prize row's draw time is the event's end. It is not editable on a `one_winner`
  event.

### 2. The draw

- `draw-lucky-draw.ts` also picks up `one_winner` events whose end has passed and that
  have no result.
- It uses only entries made before the end, weighted by tickets, with the same pick
  (`pickWonRow`) and the same disabled-account rule as today.
- The winner gets **every** prize that wasn't cancelled: card prizes as reward pulls,
  credit prizes as bonus credit, exactly as section 8 of the Lucky Draw spec. Paying
  each prize stays idempotent, and the job retries until every prize is paid. An event
  is never left drawn but part-paid.
- No entries: the result says "No entries" and nothing is paid.

### 3. Rules around the event

- Publishing refuses an event whose window overlaps another published event that still
  has a prize left to draw. Admin sees which event it clashes with.
- Before the start, prizes can be added, edited and removed. From the start on, they
  are locked and only the name may change.
- Withdrawing a live event refunds every entrant and is the only way to stop one. A
  single prize can't be cancelled once the event has started. _(My call: it would
  change what people entered for.)_
- `luckyDrawPage` must pick the running event that still has something to draw, so a
  fully drawn event can never hide a live one. This also fixes the old-rule case.
- `luckyDrawLive` keeps its meaning.

### 4. Entering

- A new route, `POST /store/lucky-draw/events/:id/enter`, with the same checks as
  today's prize route: signed in, has a top-up, enough tickets, event open. The refusal
  reasons stay the same (`not_open`, `closed`, `no_topup`, `not_enough_tickets`), and
  it is rate limited like the prize route.
- The ledger writes `reason: entry` with `ref` = the entry id. A refund uses
  `<eventId>:<customerId>`.

### 5. Admin

- New event form: name, start, end and the prize pool it already has. The per-prize
  draw time goes away for new events.
- The event list shows total tickets, entrants, seed hash, status and winner.
- The entrants drawer works per event.
- "Add prize" and prize edits are disabled from the start time on, with a line saying
  why.
- Old events keep today's screens.

### 6. Storefront

- `/lucky-draw` for a `one_winner` event shows one pot: the event name, a countdown to
  the end, every prize with its value, the pot's total value, the customer's tickets in
  the event and their chance (my tickets ÷ all tickets), the top 10 entrants, and one
  "Put tickets in" action using the existing enter sheet.
- At the end: one spin for the event, using the existing spin moment. It replays the
  stored result, then shows the winner and everything they won.
- Results tab: one row per event, opening a detail page with its prizes and frozen entries.
  The seed and hash stay off the customer's page (operator 2026-10-25), as on old
  results; admin shows them. Old per-prize results stay readable.
- No running event: the existing "coming soon" panel, plus the next event's name and
  start time if one is published.
- A `per_prize` event renders as it does today.
- The rule copy on the page changes to say one winner takes every prize.

## Constraints

- Migrations are additive, and `prize_id` becoming nullable must not touch old rows.
- New response fields are optional in the storefront schema, so either side can deploy
  first.
- Any new admin permission is declared in `src/policies`.

## Left to the builder

- Exact names, and whether the event result is a new table or an extension of
  `lucky_draw_result`, as long as one draw per event is enforced by the database and
  history stays checkable.
- The look of the pot, measured with the Playwright scripts against `DESIGN.md`.

## Settled after the builder check

- Drafts that exist at deploy run the new rules: publishing one sets it to `one_winner` and moves every prize's draw time to the event's end. Only events already published keep the old rules. _(My call: the operator said only published events stay old.)_
- If a prize's card has gone missing at the draw, the draw waits and warns rather than paying part of the pot. Deleting a card in a published, undrawn event is refused. _(My call.)_
- Withdrawing a live event has its own admin action and refunds every entrant.
- Open question for the operator: whether an old-rule event is already published across November on live. If so, the overlap rule blocks one-winner events in that window until its prizes are drawn or cancelled.
