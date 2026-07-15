# Me page redesign — Show layout + showcase + quick-access reorder

Approved 2026-07-15. Reference: SHOWGER (Show) app "Me" screen.

## Layout (top → bottom)

1. **Header** — framed avatar (tap to change photo, camera badge kept), display
   name, stats row `{pulls} Pulls · {points} Points` (replaces the reference's
   Following/Followers), and an `@handle` chip with copy button. Email leaves
   the header (lives in Settings).
2. **Level card** — existing VIP card restyled: `LV {n}` left, progress bar
   with `{progress}` / `{threshold}` flanking labels, caption
   "RM X more to LV {next}". Tap → /vip. Daily-box/voucher lines stay beneath
   (Daily Box loses its quick-access tile; this is its remaining entry point).
3. **橱窗 Showcase (new)** — horizontal scroll strip of showcased cards
   (SlabImage; slab composite preferred), each → /card/[handle]. "Manage" →
   /vault. Empty state: prompt to showcase cards in the Vault. Hidden when the
   profile read fails.
4. **Wallet bar** — compact horizontal: "Wallet ▸ RM x.xx" (→ /wallet),
   Withdraw + Top Up buttons. Locked-balance note kept when nonzero.
5. **Half-width cards** — Invite Friends (→ /referrals) | Points Balance
   (→ own public profile).
6. **Quick Access** (4×2): History /transactions · Orders /orders · Vouchers
   /vouchers · Inbox /notifications · Download /download (stub) · Address
   /addresses (new) · Support /contact · Settings /settings.
   (VIP, Daily Box, Withdraw tiles removed — reachable via level card, VIP
   card lines, and wallet bar.)
7. **Frames card** — demoted below Quick Access, otherwise unchanged.
8. About links + Logout unchanged.

## Data

One added read on /me: `getPublicProfile(handle)` (cached public route) —
supplies `stats.pulls`, `stats.points`, and `collection` (showcased cards) in
one round-trip. No `getVault()` on /me. Profile fetch skipped when the handle
read fails; dependent UI degrades (stats row hidden, showcase hidden, points
card shows —).

## New pages

- `/addresses` (account group): list `getAddresses()`, add via `addAddress()`.
  No edit/delete (data layer doesn't support it yet). Form mirrors
  RequestDeliveryModal's fields; the modal is left untouched.
- `/download` (public): one-screen "app coming soon" stub.

## Components

- `AppearanceCard.tsx` splits into `MeHeader.tsx` (avatar/photo upload, name,
  stats, handle-copy chip) and `FramesCard.tsx` (frames grid + VIP-read
  self-heal), logic carried over unchanged.
- `TopUpButton` gains an optional `className` (compact use in the wallet bar).
