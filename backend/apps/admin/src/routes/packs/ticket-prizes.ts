// The ticket pack editor's pure half (spec 2026-10-30 Lucky Pack §2). Split out
// of the page for the reason lucky-draw/prize-pool.ts is: the admin vitest runner
// has no DOM.
//
// A ticket row IS an EditRow, so previewSets, tierSplit, applyTierSplit and
// SetRateCell work on it unchanged and a ticket pack cannot drift from a card
// pack's rules. Two fields carry the difference: `name` holds the amount as typed
// and `card_id` is a stable row key, never the typed text, or the row would
// remount and lose focus on each keystroke.
import { PCT_SCALE } from '@acme/odds-math';
import type {
  AdminTicketPrize,
  AdminTicketPrizeEntry,
} from '../../lib/admin-rest';
import { rowsToSetEntries, type EditRow } from '../../lib/odds-rows';
import type { AdminPack } from '../../lib/packs-api';

/** Same ceiling as the server: an event sums entries into an int4 total. */
export const MAX_TICKET_AMOUNT = 10_000;

/** A missing prize_type is a card pack: only a positive answer opens the ticket
 *  editor, so a backend that doesn't send the field yet changes nothing. */
export const isTicketPack = (pack: Pick<AdminPack, 'prize_type'>): boolean =>
  pack.prize_type === 'tickets';

/** A whole number of at least 1, or null. Digits only, so '1e3' and '1.0' don't
 *  slip through `Number()`. */
export const parseTicketAmount = (input: string): number | null => {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return null;
  const amount = Number(text);
  return amount >= 1 && amount <= MAX_TICKET_AMOUNT ? amount : null;
};

const emptyRow = (card_id: string): EditRow => ({
  card_id,
  name: '',
  image: '',
  slab_image: null,
  rarity: 'Common',
  market_value: 0,
  stock: null,
  currentPct: 0,
  locked: false,
  pctInput: '0',
  pctInput2: '',
  pctInput3: '',
  topHitInput: '',
});

let nextKey = 0;
/** "Add amount": an unlocked Common, the way a newly admitted card joins. */
export const blankTicketRow = (): EditRow => emptyRow(`new-${++nextKey}`);

/** The server's rows as the editor's buffer, smallest amount first. Sets 2/3 read
 *  the raw nullable weights, so "inherited" stays apart from a real 0%. */
export const mapTicketPrizesToRows = (prizes: AdminTicketPrize[]): EditRow[] =>
  [...prizes]
    .sort((a, b) => a.tickets - b.tickets)
    .map((p) => ({
      ...emptyRow(`tickets-${p.tickets}`),
      name: String(p.tickets),
      rarity: p.rarity,
      locked: p.locked,
      currentPct: p.weight / PCT_SCALE,
      pctInput: String(p.weight / PCT_SCALE),
      pctInput2: p.weight_2 == null ? '' : String(p.weight_2 / PCT_SCALE),
      pctInput3: p.weight_3 == null ? '' : String(p.weight_3 / PCT_SCALE),
    }));

export type TicketAmountProblem = 'invalid' | 'duplicate';

/** What's wrong with each row's amount, by row key. Duplicates compare the
 *  number, so '100' and '0100' clash. */
export const ticketAmountProblems = (
  rows: EditRow[],
): Map<string, TicketAmountProblem> => {
  const seen = new Map<number, number>();
  for (const r of rows) {
    const amount = parseTicketAmount(r.name);
    if (amount !== null) seen.set(amount, (seen.get(amount) ?? 0) + 1);
  }
  const problems = new Map<string, TicketAmountProblem>();
  for (const r of rows) {
    const amount = parseTicketAmount(r.name);
    if (amount === null) problems.set(r.card_id, 'invalid');
    else if ((seen.get(amount) ?? 0) > 1) problems.set(r.card_id, 'duplicate');
  }
  return problems;
};

/** The odds maths' verdict (from previewSets) plus the amount rules. */
export const ticketSaveBlocked = (
  rows: EditRow[],
  previewError: string | null,
): boolean => previewError !== null || ticketAmountProblems(rows).size > 0;

/** The save body. Rates go through rowsToSetEntries, so '' stays "inherit" and
 *  the server balances the same numbers the preview did. */
export const ticketRowsToPayload = (rows: EditRow[]): AdminTicketPrizeEntry[] =>
  rowsToSetEntries(rows).map((e, i) => ({
    tickets: Number(rows[i].name),
    rarity: e.rarity,
    locked: e.locked,
    pct: e.pct,
    pct_2: e.pct_2,
    pct_3: e.pct_3,
  }));
