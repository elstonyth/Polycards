import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { MedusaContainer } from '@medusajs/framework/types';
import { MedusaError } from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../modules/assistant';
import type AssistantModuleService from '../../../modules/assistant/service';
import { MAX_SCHEDULES, nextRun } from './schedule';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import type { Need } from './access';

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
  // Taking a bank number off the ban list (owner, 2026-11-04), named by last 4
  // among one player's own numbers: the token never carries a full number.
  | {
      kind: 'unban_number';
      customer_id: string;
      username: string;
      bank_code: string;
      last4: string;
      reason: string;
    };

/** What an unban needs, checked again when the person taps it: its own policy
 *  (policies/assistant.ts), held by super admins and the Support viewer. */
export const UNBAN_NEED: Need = {
  resource: 'assistant_unban',
  operation: 'update',
};

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
    return p;
  } catch {
    return null;
  }
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
    try {
      await container
        .resolve<PacksModuleService>(PACKS_MODULE)
        .liftPayoutAccountBan({
          customerId: proposal.customer_id,
          adminId: access.userId,
          last4: proposal.last4,
          bankCode: proposal.bank_code,
          reason: proposal.reason,
        });
    } catch (err) {
      // Already lifted (a second tap), or no longer on this player.
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
