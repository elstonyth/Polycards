import {
  adjustCustomerCredits,
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

export interface GroupCreditAdjustment {
  id: string;
  customers: GroupCreditCustomer[];
  amount: number;
  note: string;
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
): GroupCreditAdjustment | null {
  const amount = parseGroupCreditAmount(amountText);
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
  };
}

// Every retry keeps the confirmed snapshot and original request key. A lost
// response may already have committed; the server safely replays that result.
export async function runGroupCreditAdjustment(
  batch: GroupCreditAdjustment,
  previous: GroupCreditResults,
  onProgress: (results: GroupCreditResults) => void,
): Promise<GroupCreditResults> {
  const results = { ...previous };
  for (const customer of batch.customers) {
    if (results[customer.id]?.status === 'succeeded') continue;
    try {
      const result = await adjustCustomerCredits(
        customer.id,
        batch.amount,
        batch.note,
        `${batch.id}:${customer.id}`,
      );
      results[customer.id] = { status: 'succeeded', balance: result.balance };
    } catch (error) {
      results[customer.id] = {
        status: 'failed',
        message:
          error instanceof Error ? error.message : 'Credit adjustment failed.',
      };
    }
    onProgress({ ...results });
  }
  return results;
}
