import { describe, expect, it } from 'vitest';
import { pressOutcome } from '../press-outcome';
import type { RolledBatch, RollMode, RollResult } from '../roll-batch';
import { ticketCard } from '@/lib/packs-data';
import type { WonCard } from '@/lib/actions/packs';

// The money rules that run after a press, as one decision table: every
// RollResult kind against the account that rolled being the one signed in now,
// a different one (an account switch mid-roll), or nobody. No DOM — the hook
// carries the effects out, and its own suite proves it does.

const won = (handle: string): WonCard => ({
  handle,
  name: handle,
  image: `/x/${handle}.webp`,
  slabImage: null,
  priceMyr: 20,
  rarity: 'Rare',
  pokemonDex: null,
  spriteImage: null,
});

const batch = (over: Partial<RolledBatch> & { mode: RollMode }): RolledBatch => ({
  spinAt: 1,
  cards: [won('a')],
  offers: [null],
  balance: null,
  locked: false,
  forId: 'cus_1',
  giftsUsed: 0,
  ...over,
});

const ok = (b: RolledBatch): RollResult => ({ ok: true, batch: b });

/** The three identities a result can come back to. */
const SAME = 'cus_1';
const SWITCHED = 'cus_2';
const SIGNED_OUT = null;

describe('pressOutcome — a roll that landed', () => {
  const paid = batch({
    mode: 'paid',
    cards: [won('a'), won('b')],
    balance: 400,
    giftsUsed: 1,
  });

  it('same account: paint the debit, spend the gifts, light the vault, count the paid rows', () => {
    expect(pressOutcome(ok(paid), SAME, 1)).toEqual({
      kind: 'rolled',
      batch: paid,
      applyBalance: 400,
      consumeGifts: 1,
      refreshVaultDot: true,
      pixelRows: 1,
    });
  });

  it.each([SWITCHED, SIGNED_OUT])(
    'account switched to %s mid-roll: nothing lands on the new account',
    (now) => {
      expect(pressOutcome(ok(paid), now, 1)).toEqual({
        kind: 'rolled',
        batch: paid,
        applyBalance: null,
        consumeGifts: 0,
        refreshVaultDot: false,
        // The open happened and was paid for — an ads event, not a balance.
        pixelRows: 1,
      });
    },
  );

  it('a press fully covered by gifts is no paid open', () => {
    const gifted = batch({ mode: 'paid', balance: 500, giftsUsed: 1 });
    expect(pressOutcome(ok(gifted), SAME, 1)).toMatchObject({
      pixelRows: 0,
      consumeGifts: 1,
    });
  });

  it('a ticket roll puts nothing in the vault', () => {
    const tickets = batch({
      mode: 'paid',
      cards: [ticketCard(100, 'Rare')],
      balance: 490,
    });
    expect(pressOutcome(ok(tickets), SAME, 0)).toMatchObject({
      applyBalance: 490,
      refreshVaultDot: false,
      pixelRows: 1,
    });
  });

  it.each([
    ['free-rip', null],
    ['free-pack', 300],
  ] as const)('a %s spends nothing, so no pixel', (mode, balance) => {
    const free = batch({ mode, balance });
    expect(pressOutcome(ok(free), SAME, 0)).toEqual({
      kind: 'rolled',
      batch: free,
      applyBalance: balance,
      consumeGifts: 0,
      refreshVaultDot: true,
      pixelRows: 0,
    });
  });

  it.each([SAME, SWITCHED, SIGNED_OUT])(
    'a demo (bound to no account) touches nothing, whoever is signed in (%s)',
    (now) => {
      const demo = batch({ mode: 'demo', forId: null });
      expect(pressOutcome(ok(demo), now, 0)).toEqual({
        kind: 'rolled',
        batch: demo,
        applyBalance: null,
        consumeGifts: 0,
        refreshVaultDot: false,
        pixelRows: 0,
      });
    },
  );
});

describe('pressOutcome — a press that failed', () => {
  // Failures never depend on who is signed in: the button just unlocks after
  // the effects, so every row runs against all three identities.
  const IDENTITIES = [SAME, SWITCHED, SIGNED_OUT];

  const cases: [string, RollResult, number, object][] = [
    [
      'unreachable: the charge may have landed — warn, re-read the balance first',
      { ok: false, kind: 'unreachable' },
      0,
      {
        error:
          "Couldn't reach the machine. Check your balance before spinning again.",
        needsTopUp: false,
        openLogin: false,
        resetGifts: false,
        refreshVaultDot: false,
        refetchBalance: true,
      },
    ],
    [
      'unreachable with gifts offered: the gifts may be spent too',
      { ok: false, kind: 'unreachable' },
      2,
      { resetGifts: true, refetchBalance: true },
    ],
    [
      'needs auth: open the login, no error line',
      { ok: false, kind: 'rejected', error: 'Log in', needsAuth: true },
      0,
      {
        error: null,
        needsTopUp: false,
        openLogin: true,
        resetGifts: false,
        refreshVaultDot: false,
        refetchBalance: false,
      },
    ],
    [
      'stale gifts: refused before any charge — say so, re-read the gifts',
      {
        ok: false,
        kind: 'rejected',
        error: 'Your vault pack is gone',
        staleGifts: true,
      },
      1,
      {
        error: 'Your vault pack is gone',
        needsTopUp: false,
        openLogin: false,
        resetGifts: true,
        refreshVaultDot: false,
        refetchBalance: false,
      },
    ],
    [
      'needs a top-up: show it, nothing was charged',
      { ok: false, kind: 'rejected', error: 'Not enough', needsTopUp: true },
      0,
      {
        error: 'Not enough',
        needsTopUp: true,
        openLogin: false,
        resetGifts: false,
        refreshVaultDot: false,
        refetchBalance: false,
      },
    ],
    [
      'any other refusal: the debit may be real — light the vault, re-read the balance',
      { ok: false, kind: 'rejected', error: 'The card is in your Vault' },
      0,
      {
        error: 'The card is in your Vault',
        needsTopUp: false,
        openLogin: false,
        resetGifts: false,
        refreshVaultDot: true,
        refetchBalance: true,
      },
    ],
    [
      'any other refusal with gifts offered re-reads the gifts as well',
      { ok: false, kind: 'rejected', error: 'Nothing was opened' },
      1,
      { resetGifts: true, refreshVaultDot: true, refetchBalance: true },
    ],
  ];

  for (const [name, result, gifts, expected] of cases) {
    it.each(IDENTITIES)(`${name} (signed in: %s)`, (now) => {
      expect(pressOutcome(result, now, gifts)).toMatchObject({
        kind: 'failed',
        ...expected,
      });
    });
  }
});
