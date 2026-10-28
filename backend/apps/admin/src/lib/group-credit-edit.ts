import {
  adjustCustomerCredits,
  adjustCustomerTickets,
  httpStatus,
  listGroupCreditCustomersPage,
  type GroupCreditCustomer,
} from './admin-rest';

export async function loadGroupCreditCustomers(groupId: string) {
  const customers = new Map<string, GroupCreditCustomer>();
  let count: number | undefined;
  let offset = 0;
  do {
    const page = await listGroupCreditCustomersPage(groupId, offset);
    count ??= page.count;
    if (count !== page.count || (!page.customers.length && offset < count)) {
      throw new Error('Group membership changed while loading. Please reload.');
    }
    for (const customer of page.customers) customers.set(customer.id, customer);
    offset += page.customers.length;
  } while (offset < count);
  if (customers.size !== count) {
    throw new Error('Group membership changed while loading. Please reload.');
  }
  return [...customers.values()];
}

export function parseGroupCreditAmount(input: string): number | null {
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(input.trim())) return null;
  const amount = Number(input);
  return Number.isFinite(amount) &&
    amount !== 0 &&
    Math.abs(amount) <= 1_000_000
    ? amount
    : null;
}

/** Lucky Draw tickets per player: a nonzero whole number within ±10,000
 *  (the backend's MAX_ADMIN_TICKETS). */
export function parseGroupTickets(input: string): number | null {
  if (!/^[+-]?\d+$/.test(input.trim())) return null;
  const tickets = Number(input);
  return Number.isSafeInteger(tickets) &&
    tickets !== 0 &&
    Math.abs(tickets) <= 10_000
    ? tickets
    : null;
}

export interface GroupCreditAdjustment {
  id: string;
  customers: GroupCreditCustomer[];
  amount: number;
  note: string;
  /** Spend-only bonus credit (ledger reason bonus_grant), the default for
   *  operator grants since 2026-10-11; false = withdrawable credit. */
  bonus: boolean;
  /** Lucky Draw tickets instead of credit: `amount` is a ticket count. */
  tickets?: boolean;
}

export type GroupCreditResults = Record<
  string,
  | { status: 'succeeded'; balance: number }
  | { status: 'failed'; message: string }
>;

export function createGroupCreditAdjustment(
  customers: GroupCreditCustomer[],
  selected: Set<string>,
  amountText: string,
  note: string,
  bonus: boolean,
  tickets = false,
): GroupCreditAdjustment | null {
  const amount = tickets
    ? parseGroupTickets(amountText)
    : parseGroupCreditAmount(amountText);
  const targets = customers.filter((customer) => selected.has(customer.id));
  if (
    amount === null ||
    !targets.length ||
    !note.trim() ||
    note.trim().length > 512
  ) {
    return null;
  }
  return {
    id: crypto.randomUUID(),
    customers: targets.map((customer) => ({ ...customer })),
    amount,
    note: note.trim(),
    bonus: tickets ? false : bonus,
    ...(tickets ? { tickets: true } : {}),
  };
}

// The admin money routes share a 30-per-10s burst budget, so a large group
// runs into 429s; each player waits it out instead of failing.
const RATE_LIMIT_RETRIES = 8;
const RATE_LIMIT_WAIT_MS = 5_000;

async function withRateLimitRetry<T>(
  send: () => Promise<T>,
  wait: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (httpStatus(error) !== 429 || attempt >= RATE_LIMIT_RETRIES) {
        throw error;
      }
      await wait(RATE_LIMIT_WAIT_MS);
    }
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// Every retry keeps the confirmed snapshot and original request key. A lost
// response may already have committed; the server safely replays that result.
export async function runGroupCreditAdjustment(
  batch: GroupCreditAdjustment,
  previous: GroupCreditResults,
  onProgress: (results: GroupCreditResults) => void,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<GroupCreditResults> {
  const results = { ...previous };
  for (const customer of batch.customers) {
    if (results[customer.id]?.status === 'succeeded') continue;
    const key = `${batch.id}:${customer.id}`;
    try {
      const result = await withRateLimitRetry<{ balance: number }>(
        () =>
          batch.tickets
            ? adjustCustomerTickets(customer.id, batch.amount, batch.note, key)
            : adjustCustomerCredits(
                customer.id,
                batch.amount,
                batch.note,
                key,
                batch.bonus ? 'bonus' : undefined,
                true, // silent: a group edit never messages every member
              ),
        wait,
      );
      results[customer.id] = { status: 'succeeded', balance: result.balance };
    } catch (error) {
      results[customer.id] = {
        status: 'failed',
        message:
          error instanceof Error ? error.message : 'Adjustment failed.',
      };
    }
    onProgress({ ...results });
  }
  return results;
}
