import {
  MAX_ENTRY_TICKETS,
  MAX_TASK_TICKETS,
  aggregateEntries,
  drawSeedHash,
  drawWinner,
  newDrawSeed,
  validateEntryTickets,
  validateTaskTickets,
  winningTicketIndex,
} from '../lucky-draw';

const SEED = 'a'.repeat(64);

it('aggregateEntries sums per customer and sorts by customer_id', () => {
  const rows = [
    { id: 'e1', customer_id: 'cus_b', tickets: 20 },
    { id: 'e2', customer_id: 'cus_a', tickets: 30 },
    { id: 'e3', customer_id: 'cus_b', tickets: 30 },
  ];
  expect(aggregateEntries(rows)).toEqual([
    { customer_id: 'cus_a', tickets: 30 },
    { customer_id: 'cus_b', tickets: 50 },
  ]);
});

it('drawSeedHash is sha256 hex of the seed string', () => {
  expect(drawSeedHash(SEED)).toBe(
    'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
  );
});

it('winningTicketIndex is HMAC-SHA256(seed, prizeId) mod total — fixed vectors', () => {
  expect(winningTicketIndex(SEED, 'ldpz_test', 100)).toBe(41);
  expect(winningTicketIndex(SEED, 'ldpz_test', 10)).toBe(1);
  expect(winningTicketIndex(SEED, 'ldpz_test', 3)).toBe(2);
  expect(winningTicketIndex(SEED, 'ldpz_other', 100)).toBe(31);
});

it('drawWinner walks cumulative tickets in entrant order', () => {
  const entrants = [
    { customer_id: 'cus_a', tickets: 30 }, // 0..29
    { customer_id: 'cus_b', tickets: 50 }, // 30..79  <- index 41
    { customer_id: 'cus_c', tickets: 20 }, // 80..99
  ];
  expect(drawWinner(entrants, SEED, 'ldpz_test')).toEqual({
    winner: { customer_id: 'cus_b', tickets: 50 },
    ticketIndex: 41,
    totalTickets: 100,
  });
});

it('drawWinner returns null with no tickets', () => {
  expect(drawWinner([], SEED, 'ldpz_test')).toBeNull();
});

it('newDrawSeed is 64 hex chars and differs per call', () => {
  const a = newDrawSeed();
  const b = newDrawSeed();
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a).not.toBe(b);
});

it('validateTaskTickets: null/undefined → 0; integer 0..MAX_TASK_TICKETS; else INVALID_DATA', () => {
  expect(validateTaskTickets(undefined)).toBe(0);
  expect(validateTaskTickets(null)).toBe(0);
  expect(validateTaskTickets(50)).toBe(50);
  for (const bad of [-1, 1.5, '5', MAX_TASK_TICKETS + 1])
    expect(() => validateTaskTickets(bad)).toThrow();
});

it('validateEntryTickets: integer 1..MAX_ENTRY_TICKETS; else INVALID_DATA', () => {
  expect(validateEntryTickets(1)).toBe(1);
  for (const bad of [0, -3, 2.5, '10', null, MAX_ENTRY_TICKETS + 1])
    expect(() => validateEntryTickets(bad)).toThrow();
});
