import { recomputeExternalStamps } from '../external-backfill';

// Rows are chronological (the caller sorts by created_at, id). Amounts are
// signed 2dp MYR; external_funded_cents is signed integer sen or NULL (pre-1b).
const topup = (id: string, amount: number, ext: number | null = null) => ({
  id,
  reason: 'topup',
  amount,
  external_funded_cents: ext,
  reference: null as string | null,
});
const open = (id: string, amount: number, ext: number | null = null) => ({
  id,
  reason: 'pack_open',
  amount,
  external_funded_cents: ext,
  reference: null as string | null,
});

it('stamps pre-1b NULL topups and replays consumption over the opens in order', () => {
  const diff = recomputeExternalStamps([
    topup('t1', 100), // NULL → +10000
    open('o1', -60), // consumes 6000
    open('o2', -60), // consumes remaining 4000 (capped)
    open('o3', -60), // external exhausted → 0
  ]);
  expect(diff.get('t1')).toBe(10000);
  expect(diff.get('o1')).toBe(-6000);
  expect(diff.get('o2')).toBe(-4000);
  expect(diff.get('o3')).toBe(0);
});

it('buyback/commission income never refills the external balance', () => {
  const diff = recomputeExternalStamps([
    topup('t1', 10), // +1000
    open('o1', -10), // consumes 1000
    {
      id: 'b1',
      reason: 'buyback',
      amount: 500,
      external_funded_cents: null,
      reference: null,
    },
    open('o2', -100), // buyback-funded → 0
  ]);
  expect(diff.get('o2')).toBe(0);
  expect(diff.has('b1')).toBe(false); // non-topup/non-open rows untouched
});

it('a reversal mirrors its original stamp and restores the balance', () => {
  const diff = recomputeExternalStamps([
    topup('t1', 50), // +5000
    open('o1', -50), // consumes 5000
    {
      id: 'r1',
      reason: 'pack_open',
      amount: 50,
      external_funded_cents: null,
      reference: 'reversal:o1',
    },
    open('o2', -30), // restored balance → consumes 3000
  ]);
  expect(diff.get('o1')).toBe(-5000);
  expect(diff.get('r1')).toBe(5000);
  expect(diff.get('o2')).toBe(-3000);
});

it('is idempotent: already-correct post-1b rows produce an empty diff', () => {
  const diff = recomputeExternalStamps([
    topup('t1', 100, 10000),
    open('o1', -60, -6000),
    open('o2', -60, -4000),
    open('o3', -60, 0),
  ]);
  expect(diff.size).toBe(0);
});

it('flips a NULL-basis topup even when there are no opens', () => {
  const diff = recomputeExternalStamps([topup('t1', 25)]);
  expect(diff.get('t1')).toBe(2500);
  expect(diff.size).toBe(1);
});

it('ignores non-positive topups and is empty-safe', () => {
  expect(recomputeExternalStamps([]).size).toBe(0);
  const diff = recomputeExternalStamps([topup('t1', 0), topup('t2', -5)]);
  expect(diff.size).toBe(0);
});
