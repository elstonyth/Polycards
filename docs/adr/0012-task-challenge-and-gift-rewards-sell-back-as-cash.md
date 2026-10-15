# ADR 0012 — Task, challenge and gift rewards sell back as withdrawable money

- **Status**: Accepted
- **Date**: 2026-10-15
- **Supersedes**: the gift-pack part of the 2026-10-09 rule (#712) and the
  reward part of #748 (2026-10-11). Those minted gift packs and task and
  weekly-challenge rewards (card and slab prizes, free rips) with a full
  `bonus_bp`, so their whole sell-back had to be spent on packs before it could
  be withdrawn.

## Context

Since #712 a card from an admin gift pack, and since #748 every task or
weekly-challenge reward pull, sold back with the whole sale stamped as
`external_funded_cents`, so it landed in "Still to use on packs". The rewards
are a card or slab handed over as a task reward (the `'task-reward'` sentinel
pack), a weekly-challenge prize (`challenge-<week>`) and a free rip (a task
pack reward, opened from a real pack). The owner decided on 2026-10-15 that
these are things the customer was given or earned, and should sell back like a
card they paid for.

## Decision

- **A reward's or gift's sale holds nothing.** `sellbackHoldBp` in
  `bonus-credit.ts` returns 0 for every `source = 'reward'` or
  `source = 'gift'` pull, and the pull's `bonus_bp` for every other pull. The
  sell step (`buyback-pull.ts`), the vault quote and the open-batch quote
  (`buyback.bonus`) all use it.
- **Decided at sell time.** Pulls already in vaults follow the new rule when
  sold. `bonus_bp` is still minted full on rewards and gifts, because it also
  keeps them out of VIP, the boards, tasks and the challenge. There is no
  migration.
- **Forward only.** Sales made before the deploy keep their stamp, and their
  hold stays until it is spent on packs.
- **Still two rounds** (ADR 0010, the 2026-10-09 rule): bonus credit (the
  bonus-paid share of a pull) and the welcome pack (`source = 'free'`).
- Rule 1 is unchanged: nothing is withdrawable before the first real top-up.
  Shipping is unchanged too (zone delivery fee, #790).

## Consequences

- The single-open quote (`open`) never sees a reward or a gift pull, so it
  keeps reading `bonus_bp` directly. The free-rip spin quote carries no held
  part.
