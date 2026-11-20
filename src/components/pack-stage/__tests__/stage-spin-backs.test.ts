import { describe, expect, it } from 'vitest';

import type { PackBackDetails } from '../contract-step2';
import {
  BACK_REPRINT_DEBOUNCE_MS,
  backPrintKey,
  createSpinBackQueue,
  isPrintableBack,
  spinPrintIdle,
} from '../stage-spin-backs';

/** A slice of pack-3d/pack-print-packs.ts's fixture (this folder may not import pack-3d). */
const ODDS = [
  { label: 'Immortal', chance: '0.1%' },
  { label: 'Legendary', chance: '1.4%' },
  { label: 'Mythical', chance: '3.5%' },
  { label: 'Rare', chance: '22%' },
  { label: 'Uncommon', chance: '30%' },
  { label: 'Common', chance: '43%' },
];
const back = (name: string, price: string): PackBackDetails => ({
  price,
  productLine: [name, 'Pokémon'],
  odds: ODDS,
  buyback: { headline: '90% instant buyback', rule: 'Rule.' },
});
const ROLLOUT_PACK_DETAILS: Record<string, PackBackDetails> =
  Object.fromEntries(
    [
      '151',
      'cr',
      'delta-reign',
      '30th-celebration',
      'ah',
      'bronze-pack',
      'silver-pack',
      'gold-pack',
      'platinum-pack',
      'diamond-pack',
      'poncho-pack',
    ].map((id, k) => [id, back(id, `RM ${10 + k}.00`)]),
  );
const IDS = Object.keys(ROLLOUT_PACK_DETAILS);
const list = (ids = IDS) =>
  ids.map((id) => ({ id, details: ROLLOUT_PACK_DETAILS[id] ?? null }));
const env = (now: number, idle = true, resident = (_: string) => true) => ({
  now,
  idle,
  resident,
  distance: (id: string) => IDS.indexOf(id),
});

describe('printable backs (no-odds rule)', () => {
  it('needs pull odds rows', () => {
    const d = ROLLOUT_PACK_DETAILS['151']!;
    expect(isPrintableBack(d)).toBe(true);
    expect(isPrintableBack({ ...d, odds: null })).toBe(false);
    expect(isPrintableBack({ ...d, odds: [] })).toBe(false);
    expect(isPrintableBack(null)).toBe(false);
    expect(backPrintKey({ ...d, odds: null })).toBe('');
    expect(backPrintKey(d)).not.toBe(backPrintKey({ ...d, price: 'RM 1.00' }));
  });
});

describe('the spin back queue', () => {
  it('prints only when idle, one at a time, nearest the centre first', () => {
    const q = createSpinBackQueue();
    q.setBacks(list(), 0);
    expect(q.next(env(0, false))).toBeNull();
    expect(q.next(env(0))).toBe('151');
    expect(q.next(env(0))).toBeNull(); // one in flight
    q.printed('151', true);
    expect(q.status('151')).toBe('ready');
    expect(q.next(env(0))).toBe('cr');
  });

  it('never prints a back without odds, and skips packs that are not resident', () => {
    const q = createSpinBackQueue();
    q.setBacks(
      [
        { id: 'a', details: { ...ROLLOUT_PACK_DETAILS['151']!, odds: null } },
        { id: 'b', details: null },
        { id: 'c', details: ROLLOUT_PACK_DETAILS.cr! },
      ],
      0,
    );
    const e = {
      now: 0,
      idle: true,
      resident: (id: string) => id !== 'c',
      distance: () => 0,
    };
    expect(q.next(e)).toBeNull();
    expect(q.next({ ...e, resident: () => true })).toBe('c');
    expect(q.details('a')).toBeNull();
  });

  it('a new set frees every back first and starts front-only', () => {
    const q = createSpinBackQueue();
    q.setBacks(list(), 0);
    for (let k = 0; k < 3; k++) {
      const id = q.next(env(0));
      q.printed(id!, true);
    }
    const inFlight = q.next(env(0));
    expect(inFlight).toBe('30th-celebration');
    const free = q.setBacks(list(IDS.slice(5)), 10);
    expect(free.sort()).toEqual(
      ['151', '30th-celebration', 'cr', 'delta-reign'].sort(),
    );
    expect(q.ready()).toEqual([]);
    // the overtaken print is ignored when it lands
    q.printed('30th-celebration', true);
    expect(q.status('30th-celebration')).toBe('none');
    expect(q.pending()).toBe(true);
  });

  it('focus start (null) frees them all', () => {
    const q = createSpinBackQueue();
    q.setBacks(list(), 0);
    q.printed(q.next(env(0))!, true);
    expect(q.setBacks(null, 5)).toEqual(['151']);
    expect(q.next(env(5))).toBeNull();
  });

  it('a changed back reprints after 300 ms; odds gone frees it', () => {
    const q = createSpinBackQueue();
    q.setBacks(list(['151', 'cr']), 0);
    q.printed(q.next(env(0))!, true);
    q.printed(q.next(env(0))!, true);
    const changed = [
      {
        id: '151',
        details: { ...ROLLOUT_PACK_DETAILS['151']!, price: 'RM 41.00' },
      },
      { id: 'cr', details: { ...ROLLOUT_PACK_DETAILS.cr!, odds: null } },
    ];
    expect(q.setBacks(changed, 1000)).toEqual(['cr']);
    expect(q.status('cr')).toBe('none');
    expect(q.next(env(1000 + BACK_REPRINT_DEBOUNCE_MS - 1))).toBeNull();
    expect(q.status('151')).toBe('ready'); // old print stays drawn meanwhile
    expect(q.next(env(1000 + BACK_REPRINT_DEBOUNCE_MS))).toBe('151');
  });

  it('a dropped handle loses its back and is printed again when resident', () => {
    const q = createSpinBackQueue();
    q.setBacks(list(['151']), 0);
    q.printed(q.next(env(0))!, true);
    q.dropped('151');
    expect(q.status('151')).toBe('none');
    expect(q.next(env(1))).toBe('151');
  });
});

describe('the idle gate', () => {
  const base = {
    settled: true,
    focus: 0,
    swap: 0,
    intro: 1,
    panelNear: true,
    variant: 'paged' as const,
  };
  it('opens only at rest', () => {
    expect(spinPrintIdle(base)).toBe(true);
    expect(spinPrintIdle({ ...base, settled: false })).toBe(false);
    expect(spinPrintIdle({ ...base, focus: 0.1 })).toBe(false);
    expect(spinPrintIdle({ ...base, swap: 0.5 })).toBe(false);
    expect(spinPrintIdle({ ...base, intro: 0.9 })).toBe(false);
    expect(spinPrintIdle({ ...base, panelNear: false })).toBe(false);
    expect(spinPrintIdle({ ...base, variant: 'tip' })).toBe(false);
  });
});
