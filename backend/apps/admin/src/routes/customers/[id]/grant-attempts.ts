import { httpStatus } from '../../../lib/admin-rest';

// One idempotency key per ATTEMPT, held for the exact values it was sent with
// (`sig`). A re-press after a lost response (no HTTP status) or a 5xx replays
// the same key, so a grant that committed is not granted twice. Any change to
// the values, a success, or a 4xx refusal (nothing committed) starts fresh.
// Same contract as group-credit-edit.ts's runGroupCreditAdjustment.
//
// Module scope, not a component ref: the panel unmounts on every tab switch,
// and a ref lost there handed a retyped identical grant a fresh key, so a
// grant whose response was lost could be granted twice. A slot is one kind
// for one customer (`bonus:<id>`), so a key never carries to another player.
type Attempt = { key: string; sig: string };
const attempts = new Map<string, Attempt>();

export function attemptKey(slot: string, sig: string): string {
  const current = attempts.get(slot);
  if (current?.sig === sig) return current.key;
  const key = crypto.randomUUID();
  attempts.set(slot, { key, sig });
  return key;
}

export function settleAttempt(slot: string, err?: unknown) {
  const status = err === undefined ? 200 : httpStatus(err);
  if (status !== undefined && status < 500) attempts.delete(slot);
}
