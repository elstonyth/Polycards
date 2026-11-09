import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { MedusaContainer } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../modules/assistant';
import type AssistantModuleService from '../../../modules/assistant/service';
import { MAX_SCHEDULES, nextRun } from './schedule';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { LASTING_WRITES, type Need } from './access';
import { findBank } from '../../../modules/packs/banks';
import {
  holderNameKey,
  PERMANENT_BAN_REASON_PREFIX,
} from '../../../modules/packs/saved-accounts';

// What lasts waits for a tap (security review 2026-10-29). A note or a
// scheduled task would stay in front of the model in every later chat or run,
// so text planted in data the model read (a customer's name, a pasted email)
// could otherwise have it save one for itself. The model only proposes: the
// person sees exactly what would be saved and taps Save. The proposal goes to
// the browser signed (HMAC under a key derived from the JWT secret), so any
// instance can save it, only for the person it was made for, for 30 minutes.

export type Proposal =
  | { kind: 'note'; note: string; shared: boolean }
  | {
      kind: 'schedule';
      title: string;
      instruction: string;
      every: 'day' | 'week';
      at_time: string;
      weekday: number | null;
    }
  // Lifting a permanent ban (owner, 2026-11-03): the account logs in again with
  // its saved banks cleared, so the customer links one again themselves.
  | {
      kind: 'unban';
      customer_id: string;
      username: string;
      reason: string;
      /** When the ban this was proposed for began: a newer ban is not lifted
       *  by an old button. */
      banned_at: string;
    }
  // Unbanning a bank number for one player (owner, 2026-11-04), named by its
  // last 4 (and bank for a tie): the token never carries a full number.
  | {
      kind: 'unban_number';
      customer_id: string;
      username: string;
      bank_code: string;
      last4: string;
      reason: string;
      /** Set from the token's seal (openProposal). */
      proposed_at?: string;
    }
  // Freeing a bank number from the other accounts on it, so this player saves
  // it themselves (owner, 2026-11-04): the accounts the person was shown, by
  // id; the number by bank and last 4 again, never in full.
  | {
      kind: 'free_number';
      customer_id: string;
      username: string;
      bank_code: string;
      last4: string;
      /** numberMark of the full number: the tap frees exactly that one. */
      number_mark: string;
      from: string[];
      reason: string;
      /** Set from the token's seal (openProposal). */
      proposed_at?: string;
    }
  // One name, different people (owner, 2026-11-04: any number of other
  // accounts, each listed on the card): this player's saves stop counting them.
  | {
      kind: 'name_clash';
      customer_id: string;
      username: string;
      holder_name: string;
      with: string[];
      reason: string;
      /** Set from the token's seal (openProposal). */
      proposed_at?: string;
    };

/** What an unban needs, checked again when the person taps it: its own policy
 *  (policies/assistant.ts), held by super admins and the Support viewer. */
export const UNBAN_NEED: Need = {
  resource: 'assistant_unban',
  operation: 'update',
};

/** Unbanning a number the player never held (by the ban list) needs this too:
 *  admins, not the Support viewer (security review). So do freeing a number
 *  from other accounts and clearing a shared name (owner, 2026-11-04: admins
 *  only): they change other accounts, or let a name past them. */
export const BAN_LIST_NEED: Need = {
  resource: 'customer',
  operation: 'update',
};

/** A keyed fingerprint of a full bank number (security review 2026-11-04):
 *  the token carries this, never the number, and the tap frees only the
 *  number it matches. Keyed by the JWT secret, so last 4 + a fingerprint
 *  cannot be guessed back into the number. */
export function numberMark(accountKey: string, container: MedusaContainer): string {
  const secret = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
    .projectConfig.http.jwtSecret as string;
  const key = Buffer.from(
    hkdfSync('sha256', secret, 'polycards-assistant', 'number-mark-v1', 32),
  );
  return createHmac('sha256', key).update(accountKey).digest('base64url');
}

/** The one bank number these last 4 (and bank, for a tie) mean among `keys`;
 *  null for none or more than one. */
export function oneNumber(
  keys: { account_key: string; bank_code: string; wallet: boolean }[],
  last4: string,
  bankCode: string | null,
): string | null {
  let hits = [
    ...new Map(
      keys
        .filter((k) => !k.wallet && k.account_key.slice(-4) === last4)
        .map((k) => [k.account_key, k]),
    ).values(),
  ];
  if (hits.length > 1 && bankCode) {
    hits = hits.filter((k) => findBank(k.bank_code)?.id === bankCode);
  }
  return hits.length === 1 ? hits[0].account_key : null;
}

/** A scheduled run has nobody to tap: no lasting writes, and no unban of any
 *  kind (every tool that needs the unban policy). */
export const scheduledRunAllows = (t: {
  name: string;
  needs: Need[];
}): boolean =>
  !LASTING_WRITES.has(t.name) &&
  !t.needs.some(
    (n) =>
      typeof n === 'object' &&
      n.resource === UNBAN_NEED.resource &&
      n.operation === UNBAN_NEED.operation,
  );

const TTL_MS = 30 * 60_000;
const MAX_TOKEN = 8000;

const keyOf = (secret: string): Buffer =>
  Buffer.from(
    hkdfSync('sha256', secret, 'polycards-assistant', 'proposal-v1', 32),
  );
const macOf = (body: string, secret: string): Buffer =>
  createHmac('sha256', keyOf(secret)).update(body).digest();

export class ConfirmRefused extends Error {}

/** The proposal as a token only `userId` can save, for 30 minutes. */
export function sealProposal(
  proposal: Proposal,
  userId: string,
  secret: string,
  now = Date.now(),
): string {
  const body = Buffer.from(
    JSON.stringify({ p: proposal, u: userId, exp: now + TTL_MS }),
  ).toString('base64url');
  return `${body}.${macOf(body, secret).toString('base64url')}`;
}

/** The proposal, or null when the token is forged, someone else's or old. */
export function openProposal(
  token: unknown,
  userId: string,
  secret: string,
  now = Date.now(),
): Proposal | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const want = macOf(body, secret);
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const { p, u, exp } = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as { p?: Proposal; u?: unknown; exp?: unknown };
    if (u !== userId || typeof exp !== 'number' || exp < now || !p) {
      return null;
    }
    // When it was made comes from the seal, never from the proposal.
    return p.kind === 'unban_number' ||
      p.kind === 'free_number' ||
      p.kind === 'name_clash'
      ? { ...p, proposed_at: new Date(exp - TTL_MS).toISOString() }
      : p;
  } catch {
    return null;
  }
}

const DONE_SINCE =
  'This was done, or changed by someone, since it was proposed. Ask again if it is still needed.';

/** Whether the change a card makes was audited on the player after the card
 *  was made (security audit 2026-11-09): its own first tap, or a colleague
 *  doing or undoing it. The lift and clearing stamps leave no trace once
 *  undone, so a re-ban looks like never lifted; only the audit tells. */
async function doneSince(
  packs: PacksModuleService,
  customerId: string,
  since: string | undefined,
  same: (after: Record<string, unknown>) => boolean,
): Promise<boolean> {
  // A card from before this check carries no time: asked again.
  if (!since) return true;
  const rows = await packs.listAdminActionAudits(
    {
      entity_type: 'customer',
      entity_id: customerId,
      action: 'edit',
      created_at: { $gt: new Date(since) },
    },
    { select: ['after'] },
  );
  return rows.some(
    (r) =>
      typeof r.after === 'object' &&
      r.after !== null &&
      same(r.after as Record<string, unknown>),
  );
}

/** Saves what the person confirmed, checked again as things stand now. A
 *  second tap on the same note saves nothing more. */
export async function saveProposal(
  proposal: Proposal,
  access: {
    userId: string;
    superAdmin: boolean;
    can?(need: Need): Promise<boolean>;
  },
  container: MedusaContainer,
  now = new Date(),
): Promise<{ id: string; next_run_at?: Date }> {
  if (proposal.kind === 'unban') {
    if (!(await access.can?.(UNBAN_NEED))) {
      throw new ConfirmRefused('Your role cannot unban players.');
    }
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const [state] = await packs.listCustomerAccountStates(
      { customer_id: proposal.customer_id, disabled: true },
      { select: ['disabled_at'], take: 1 },
    );
    if (
      !state?.disabled_at ||
      new Date(state.disabled_at).toISOString() !== proposal.banned_at
    ) {
      throw new ConfirmRefused(
        'The ban changed since this was proposed. Ask again.',
      );
    }
    try {
      await packs.liftPermanentBan({
        customerId: proposal.customer_id,
        adminId: access.userId,
        reason: proposal.reason,
      });
    } catch (err) {
      // Already lifted (a second tap) or never a permanent ban.
      if (
        err instanceof MedusaError &&
        (err.type === MedusaError.Types.NOT_ALLOWED ||
          err.type === MedusaError.Types.NOT_FOUND)
      ) {
        throw new ConfirmRefused(err.message);
      }
      throw err;
    }
    return { id: proposal.customer_id };
  }
  if (proposal.kind === 'unban_number') {
    if (!(await access.can?.(UNBAN_NEED))) {
      throw new ConfirmRefused('Your role cannot unban bank numbers.');
    }
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const { last4 } = proposal;
    // Lifted, or banned again, since this card was made.
    if (
      await doneSince(
        packs,
        proposal.customer_id,
        proposal.proposed_at,
        (a) =>
          'lifted_for_player' in a &&
          (a.banned_number as { last4?: unknown } | undefined)?.last4 === last4,
      )
    ) {
      throw new ConfirmRefused(DONE_SINCE);
    }
    try {
      await packs.setPayoutBanLifted({
        customerId: proposal.customer_id,
        adminId: access.userId,
        last4: proposal.last4,
        bankCode: proposal.bank_code || null,
        lifted: true,
        reason: proposal.reason,
        fromBanList:
          access.superAdmin || ((await access.can?.(BAN_LIST_NEED)) ?? false),
      });
    } catch (err) {
      // The ban is gone, or now matches more than one number.
      if (
        err instanceof MedusaError &&
        (err.type === MedusaError.Types.NOT_ALLOWED ||
          err.type === MedusaError.Types.NOT_FOUND ||
          err.type === MedusaError.Types.INVALID_DATA)
      ) {
        throw new ConfirmRefused(err.message);
      }
      throw err;
    }
    return { id: proposal.customer_id };
  }
  if (proposal.kind === 'free_number' || proposal.kind === 'name_clash') {
    if (
      !(await access.can?.(UNBAN_NEED)) ||
      !(await access.can?.(BAN_LIST_NEED))
    ) {
      throw new ConfirmRefused(
        'Only an admin can free a bank number or clear a shared name.',
      );
    }
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    // An unban clears a name clearing, and freeing for a banned player frees
    // nothing they can use: the Unban card first.
    const [state] = await packs.listCustomerAccountStates(
      { customer_id: proposal.customer_id, disabled: true },
      { select: ['disabled_reason'], take: 1 },
    );
    if (state?.disabled_reason?.startsWith(PERMANENT_BAN_REASON_PREFIX)) {
      throw new ConfirmRefused(
        'This player is still banned: tap Unban first, then this.',
      );
    }
    // This name cleared or taken back, or this number freed, since the card.
    const nameKey =
      proposal.kind === 'name_clash'
        ? holderNameKey(proposal.holder_name)
        : null;
    const last4 = proposal.kind === 'free_number' ? proposal.last4 : null;
    if (
      await doneSince(packs, proposal.customer_id, proposal.proposed_at, (a) =>
        nameKey !== null
          ? 'cleared' in a &&
            typeof a.holder_name === 'string' &&
            holderNameKey(a.holder_name) === nameKey
          : 'held_by' in a && a.account_last4 === last4,
      )
    ) {
      throw new ConfirmRefused(DONE_SINCE);
    }
    try {
      if (proposal.kind === 'name_clash') {
        await packs.setHolderNameCleared({
          customerId: proposal.customer_id,
          adminId: access.userId,
          holderName: proposal.holder_name,
          cleared: true,
          reason: proposal.reason,
          onlyWith: proposal.with,
        });
        return { id: proposal.customer_id };
      }
      // The number again from the accounts it is freed from, by its
      // fingerprint: the token holds its last 4 only.
      const key = (
        await Promise.all(proposal.from.map((id) => packs.payoutAccountsOf(id)))
      )
        .flat()
        .map((k) => k.account_key)
        .find(
          (k) =>
            k.slice(-4) === proposal.last4 &&
            numberMark(k, container) === proposal.number_mark,
        );
      if (!key) {
        throw new ConfirmRefused(
          `Those accounts no longer hold that number ending ${proposal.last4}. Ask again.`,
        );
      }
      await packs.freePayoutAccount({
        customerId: proposal.customer_id,
        adminId: access.userId,
        accountKey: key,
        bankCode: proposal.bank_code,
        fromIds: proposal.from,
        reason: proposal.reason,
      });
    } catch (err) {
      // Already done, changed since, or a payout still on its way.
      if (
        err instanceof MedusaError &&
        (err.type === MedusaError.Types.NOT_ALLOWED ||
          err.type === MedusaError.Types.NOT_FOUND ||
          err.type === MedusaError.Types.INVALID_DATA ||
          err.type === MedusaError.Types.CONFLICT)
      ) {
        throw new ConfirmRefused(err.message);
      }
      throw err;
    }
    return { id: proposal.customer_id };
  }
  const assistant = container.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  if (proposal.kind === 'note') {
    if (proposal.shared && !access.superAdmin) {
      throw new ConfirmRefused('Only an admin can save a note for everyone.');
    }
    const scope = proposal.shared ? 'shared' : 'user';
    const [same] = await assistant.listAssistantMemories(
      { scope, user_id: access.userId, content: proposal.note },
      { take: 1 },
    );
    if (same) return { id: same.id };
    const saved = await assistant.createAssistantMemories({
      scope,
      user_id: access.userId,
      content: proposal.note,
    });
    return { id: saved.id };
  }
  const { title, instruction, every, at_time, weekday } = proposal;
  const [same] = await assistant.listAssistantSchedules(
    { user_id: access.userId, title, instruction, every, at_time },
    { take: 1 },
  );
  if (same) return { id: same.id, next_run_at: same.next_run_at };
  const [, count] = await assistant.listAndCountAssistantSchedules(
    { user_id: access.userId },
    { take: 1 },
  );
  if (count >= MAX_SCHEDULES) {
    throw new ConfirmRefused(
      `You already have ${MAX_SCHEDULES} scheduled tasks; cancel one first.`,
    );
  }
  const next_run_at = nextRun({ every, at_time, weekday }, now);
  const saved = await assistant.createAssistantSchedules({
    user_id: access.userId,
    title,
    instruction,
    every,
    at_time,
    weekday,
    next_run_at,
  });
  return { id: saved.id, next_run_at };
}
