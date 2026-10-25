import { MedusaError } from '@medusajs/framework/utils';
import {
  MAX_ADMIN_TICKETS,
  MAX_ENTRY_TICKETS,
  MAX_TASK_TICKETS,
  aggregateEntries,
  commitDrawSeed,
  deriveDrawSeed,
  drawSeedHash,
  drawWinner,
  newDrawSeed,
  requireDrawSeedSecret,
  validateAdminTickets,
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

it('validateAdminTickets: nonzero integer within ±MAX_ADMIN_TICKETS; else INVALID_DATA', () => {
  expect(validateAdminTickets(50)).toBe(50);
  expect(validateAdminTickets(-20)).toBe(-20);
  expect(validateAdminTickets(MAX_ADMIN_TICKETS)).toBe(MAX_ADMIN_TICKETS);
  expect(validateAdminTickets(-MAX_ADMIN_TICKETS)).toBe(-MAX_ADMIN_TICKETS);
  for (const bad of [
    0,
    1.5,
    '10',
    null,
    MAX_ADMIN_TICKETS + 1,
    -MAX_ADMIN_TICKETS - 1,
  ])
    expect(() => validateAdminTickets(bad)).toThrow(
      expect.objectContaining({ type: MedusaError.Types.INVALID_DATA }),
    );
});

it('deriveDrawSeed is HMAC-SHA256(secret, "lucky-draw-seed:" + nonce) hex — fixed vector', () => {
  const seed = deriveDrawSeed('test-secret', 'b'.repeat(64));
  expect(seed).toBe(
    '7e0cbfdfea31e0b95b8f7337da2f76a786f76f956dbd03af4d33dcb6564312da',
  );
  expect(drawSeedHash(seed)).toBe(
    '6869746cfa18aa25f345f3a5b0a4b0069d1531820ec93140c82449425c18e418',
  );
});

it('deriveDrawSeed refuses an empty secret', () => {
  expect(() => deriveDrawSeed('', 'b'.repeat(64))).toThrow();
});

describe('commitDrawSeed', () => {
  it('commits to the seed derived from the secret and a fresh nonce, without exposing it', () => {
    const a = commitDrawSeed('test-secret');
    expect(Object.keys(a).sort()).toEqual(['seed_hash', 'seed_nonce']);
    expect(a.seed_nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(a.seed_hash).toBe(
      drawSeedHash(deriveDrawSeed('test-secret', a.seed_nonce)),
    );
    expect(commitDrawSeed('test-secret').seed_nonce).not.toBe(a.seed_nonce);
  });
});

describe('requireDrawSeedSecret', () => {
  const saved = process.env.LUCKY_DRAW_SEED_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.LUCKY_DRAW_SEED_SECRET;
    else process.env.LUCKY_DRAW_SEED_SECRET = saved;
  });

  it('returns the configured secret', () => {
    process.env.LUCKY_DRAW_SEED_SECRET = 'configured';
    expect(requireDrawSeedSecret()).toBe('configured');
  });

  it.each([undefined, ''])('refuses NOT_ALLOWED when the secret is %p', (v) => {
    if (v === undefined) delete process.env.LUCKY_DRAW_SEED_SECRET;
    else process.env.LUCKY_DRAW_SEED_SECRET = v;
    expect(() => requireDrawSeedSecret()).toThrow(
      expect.objectContaining({
        type: MedusaError.Types.NOT_ALLOWED,
        message: 'LUCKY_DRAW_SEED_SECRET is not set',
      }),
    );
  });
});
