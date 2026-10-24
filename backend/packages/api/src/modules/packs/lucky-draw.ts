// Lucky Draw math — pure leaf (no DB, no service imports), like pick.ts / tasks.ts.
// The winner is a function of (seed, prizeId, entries): once the seed is revealed
// anyone can recompute it, and the seed hash published before the draw pins it.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import { pickWonRow } from './pick';

// Sanity ceilings so a typo'd extra zero is refused (same stance as MAX_TASK_CREDIT_MYR).
export const MAX_TASK_TICKETS = 10_000;
export const MAX_ENTRY_TICKETS = 1_000_000;
export const MAX_PRIZE_CREDIT_MYR = 50_000;

// Synthetic pull.pack_id for prize cards, like 'task-reward'.
export const LUCKY_DRAW_PULL_PACK_ID = 'lucky-draw';

export interface DrawEntryRow {
  id: string;
  customer_id: string;
  tickets: number;
}

export interface DrawEntrant {
  customer_id: string;
  tickets: number;
}

/** Sum tickets per customer, sorted by customer_id so the ticket walk is deterministic.
 *  No time filter: the draw counts every committed entry on the prize; the cut-off is
 *  enforced at entry time under the prize lock. */
export function aggregateEntries(rows: DrawEntryRow[]): DrawEntrant[] {
  const byCustomer = new Map<string, number>();
  for (const r of rows) {
    byCustomer.set(r.customer_id, (byCustomer.get(r.customer_id) ?? 0) + r.tickets);
  }
  return [...byCustomer]
    .map(([customer_id, tickets]) => ({ customer_id, tickets }))
    .sort((a, b) => (a.customer_id < b.customer_id ? -1 : a.customer_id > b.customer_id ? 1 : 0));
}

export function newDrawSeed(): string {
  return randomBytes(32).toString('hex');
}

export function drawSeedHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

/** HMAC-SHA256(seed, prizeId) mod totalTickets. A 256-bit value mod a total under
 *  2^53 has negligible modulo bias.
 *  Precondition: totalTickets is a positive integer (RangeError otherwise).
 *  Verifier detail: the HMAC key is the seed's 64-char hex STRING as UTF-8 bytes,
 *  not the 32 decoded bytes; the message is the prizeId string. */
export function winningTicketIndex(
  seed: string,
  prizeId: string,
  totalTickets: number,
): number {
  const digest = createHmac('sha256', seed).update(prizeId).digest('hex');
  return Number(BigInt('0x' + digest) % BigInt(totalTickets));
}

export function drawWinner(
  entrants: DrawEntrant[],
  seed: string,
  prizeId: string,
): { winner: DrawEntrant; ticketIndex: number; totalTickets: number } | null {
  const totalTickets = entrants.reduce((n, e) => n + e.tickets, 0);
  if (totalTickets <= 0) return null;
  const ticketIndex = winningTicketIndex(seed, prizeId, totalTickets);
  const won = pickWonRow(
    entrants.map((e) => ({ ...e, weight: e.tickets })),
    ticketIndex,
  );
  return {
    winner: { customer_id: won.customer_id, tickets: won.tickets },
    ticketIndex,
    totalTickets,
  };
}

const bad = (m: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, m);
};

const isInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v);

// The seed is never stored before the draw (staff tools and bots can read the DB):
// the prize row keeps only a random nonce (newDrawSeed()) and the seed is derived
// from a server env secret.
export function deriveDrawSeed(secret: string, nonce: string): string {
  if (!secret) bad('Lucky Draw seed secret is not configured.');
  return createHmac('sha256', secret).update(`lucky-draw-seed:${nonce}`).digest('hex');
}

/** Tickets a task grants on claim: absent → 0, else an integer 0..MAX_TASK_TICKETS. */
export function validateTaskTickets(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (!isInt(raw) || raw < 0 || raw > MAX_TASK_TICKETS) {
    bad(`tickets must be a whole number from 0 to ${MAX_TASK_TICKETS}.`);
  }
  return raw as number;
}

/** Tickets a customer spends on one entry: an integer 1..MAX_ENTRY_TICKETS. */
export function validateEntryTickets(raw: unknown): number {
  if (!isInt(raw) || raw < 1 || raw > MAX_ENTRY_TICKETS) {
    bad(`tickets must be a whole number from 1 to ${MAX_ENTRY_TICKETS}.`);
  }
  return raw as number;
}
