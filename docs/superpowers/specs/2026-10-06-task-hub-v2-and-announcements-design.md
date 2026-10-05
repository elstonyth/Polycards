# Task Hub v2 + Announcement Popup — design

Date: 2026-10-06. Approved in chat by the operator the same day ("Design looks good,
please proceed locally first").

Four operator asks, one design:

1. The `/task` rows say what the reward is only in text. Show the reward's **image**
   next to every task, and make it read as fun.
2. Admin can create achievements with richer goals than the repeating tasks. Add a
   **Daily** cadence and widen the goals daily/weekly tasks can use.
3. An admin-uploaded **announcement popup** (ads, upcoming drops, news) that every
   visitor sees on the storefront and closes with X.
4. Make the **check-in** look like a reward calendar, with sparkle particles on
   anything claimable.

## Decisions (operator answers, 2026-10-06)

| Question | Answer |
|---|---|
| What "daily tasks like achievements" means | Both: a new Daily cadence AND wider goal types for daily/weekly |
| Check-in rewards | Day 1–7 strip; existing `checkin_days` tasks are the milestones (no new payout path) |
| Popup frequency | Once per MYT day; editing/adding an announcement re-shows it |
| Several live announcements | One popup, swipe carousel |

## 1. Daily cadence + wider goals (backend)

- `task_definition.kind` gains `daily` (`daily | weekly | achievement`); a migration
  swaps the CHECK constraint.
- **Period key** (rides the existing claim unique index AND the credit idempotency
  key, so no new money logic): `daily` = the MYT calendar date (`YYYY-MM-DD`),
  `weekly` = the task-week Monday (unchanged), `achievement` = `''` (unchanged).
  The keys can be textually equal on a Monday, which is harmless — claims are keyed
  by `(customer, task, period)` and a task's kind can never change.
- **Goals per cadence** (`validateTaskRequirement`):
  - daily: `checkin_days` (days must be exactly 1 — "check in today"), `rip_count`,
    `vault_pixel_count`
  - weekly: `checkin_days` (1–7), `rip_count`, `vault_pixel_count`
  - achievement: unchanged (`reach_level`, `vault_count`, `vault_pixel_count`)
- Why not every achievement goal: `reach_level` is a lifetime ratchet — as a
  repeating goal a player who already meets it would re-claim every period.
  A per-period `vault_count` is the same number as `rip_count` without a pack
  filter, so it would be a duplicate.
- **Period pixel counts** come from **paid pack pulls only** (`source='pack'`),
  the rule `rip_count` already follows — so a task's own card reward can never
  feed a task. Achievements keep their lifetime, all-source count.
- `taskFactsFor` measures two windows — today (MYT) and this task week — and
  `taskProgress(kind, requirement, facts)` reads the window the kind names.

## 2. Reward images + check-in data (backend, `GET /store/tasks`)

- `HubReward` gains `pack_image` (pack `display_image ?? image`) and `card_image`
  (card `slab_image ?? image`), resolved in the same bounded IN queries
  `taskHubFor` already runs. `pending_spins[]` gains `pack_image`.
- Credit rewards carry no image; the storefront uses `/images/task/credits-coins.webp`.
- New top-level fields: `checkins_this_week` (number) and `day_key` (today's MYT
  date, the daily period key).

## 3. Admin Tasks page

- Cadence select: Daily / Weekly / Achievement. Goal list per cadence (from
  `REQUIREMENT_TYPES`). Daily check-in renders as "Check in today" with no count
  box; weekly check-in count input bounded 1–7.
- The list renders three tables: Daily, Weekly, Achievements.
- Goal labels say "today" / "this week" / lifetime.

## 4. Storefront `/task`

- Tabs: **Daily · Weekly · Achievements**. The pending free-rip panel moves above
  the tabs (an entitlement is not a tab's business) and shows the pack art.
- **Check-in strip** (top of Daily): seven slots, Day 1…Day 7 — the count of
  check-ins this task week, which is exactly what `checkin_days` measures (not
  weekdays). Filled slots are done; the next slot carries the Check-in action.
  Each weekly `checkin_days` task sits on slot N as a reward tile with its image;
  claimable → gold sparkle + glow, tap to claim. Those tasks render ONLY in the
  strip (not duplicated in the weekly list).
- **Task row**: reward art left (card slab with its tier glow, pack art, or credit
  coins) with an RM value badge; title + progress bar; claim pill right.
  Claimable row: chase-gold hairline, sparkle particles around the art, a shimmer
  on the Claim pill. Claimed: dimmed with a check.
- Sparkles are chase gold, only on claimable things; under reduced motion they
  hold still and the glow stays. Recorded in `DESIGN.md` as the sanctioned
  "Claimable sparkle" pattern.
- The storefront schema accepts an unknown `kind` without failing the whole hub
  parse (deploy-order safety).

## 5. Announcement popup (separate PR)

- Model `announcement` (packs module): `image_url`, `title` (nullable, ≤ 80),
  `link_url` (nullable; `/path` or http(s)), `active`, `sort`, `starts_at`,
  `ends_at`. Admin writes are audited (`entity_type 'announcement'`).
- Media kind `announcement`: any aspect ratio, sensible minimum width.
- Admin page **Announcements**: upload + preview, title, link, sort, active toggle,
  schedule, delete; list with thumbnails.
- `GET /store/announcements`: public, live rows only (active + inside window),
  sorted; storefront loader cached 60 s.
- Storefront popup: centered glass modal, image + optional caption, swipe/arrow
  carousel with dots, X / Esc / backdrop close, image tap opens the link. Shown to
  every visitor once per MYT day; the dismissal is keyed by a signature of the live
  set (ids + `updated_at`), so a new or edited announcement shows again at once.
  Waits for the cookie-consent answer, skips the spin reel, and never opens over
  another dialog.

## Delivery

- PR A `feat/task-hub-v2` (sections 1–4). PR B `feat/announcement-popup` (section 5).
- Tests: validators + progress per kind + period keys (unit), migration enum pins,
  rate-limit coverage, admin `task-draft` test, storefront schema test.
- Visual proof: standalone build + Playwright screenshots (mobile + desktop `/task`,
  the popup, both admin pages) against the local DB with demo rows.
