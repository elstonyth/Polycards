import type {
  ICustomerModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import sharp from 'sharp';
import { ASSISTANT_MODULE } from '../../../modules/assistant';
import type AssistantModuleService from '../../../modules/assistant/service';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import {
  assetOrigin,
  fetchBytes,
  localFileOrigin,
  MAX_DECODE_PIXELS,
} from '../../utils/image-fetch';
import type { Need } from './access';
import {
  BAN_LIST_NEED,
  numberMark,
  oneNumber,
  UNBAN_NEED,
  type Proposal,
} from './confirm';
import {
  clearedHolderNames,
  HOLDER_NAME_INVALID_MESSAGE,
  holderNameInvalid,
  holderNameKey,
  holderUnlikeSaved,
  normalizeHolderName,
  parseSavedBankAccounts,
  payoutAccountKey,
  PERMANENT_BAN_REASON_PREFIX,
  savedSlotFull,
} from '../../../modules/packs/saved-accounts';
import { MY_BANKS, SG_BANKS, findBank } from '../../../modules/packs/banks';
import { withdrawalDetailsError } from '../../../modules/packs/gateway-withdrawal';
import { accountLinks, VISITOR_NEED, type LinksDb } from './account-links';
import { namedIn, namedPlayer } from './named';
import { MAX_SCHEDULES, nextRun } from './schedule';

// The assistant's own memory and search (owner, 2026-10-29: "it will search
// through its own memories or conversations, and build the assets by
// searching the folders for the information it needs"):
//  - remember / recall / forget: notes staff ask it to keep. Personal notes
//    are seen only by the person who saved them; shared notes (super admins
//    only) by everyone, and are put first in every chat's instructions.
//  - search_chats: what was asked and answered before — only the asker's
//    own chats (each account sees only its own conversations).
//  - find_assets: the art to build with — pack art, card and slab images,
//    and images the assistant made before — as URLs the image tools take.
//  - schedule_task / list_schedules / cancel_schedule: tasks it does by
//    itself every day or week (schedule.ts runs them; "make sure it is also
//    able to do the scheduled tasks").

type Ctx = {
  container: MedusaContainer;
  access: {
    userId: string;
    superAdmin: boolean;
    can?(need: Need): Promise<boolean>;
  };
  /** The asker's message this turn. */
  userText?: string;
  /** The asker's own message before it in this chat (staffText). */
  askedBefore?: string;
  /** Shows the person a note or task to save with a tap (confirm.ts). */
  propose?(proposal: Proposal, summary: string): void;
};

// Notes and tasks are saved only when the person taps Save (confirm.ts):
// these tools propose. Without a chat to show the button in, nothing saves.
const proposeOrRefuse = (ctx: Ctx, proposal: Proposal, summary: string) => {
  if (!ctx.propose) {
    throw new Error(
      'This is saved only when the person taps Save in the chat; nothing was saved.',
    );
  }
  ctx.propose(proposal, summary);
};
const WAITING =
  'Nothing is saved yet: a Save button is under your answer, and it is kept only when the person taps it. Tell them so in one short line.';

type AgentTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  needs: Need[];
  run(args: Record<string, unknown>, ctx: Ctx): Promise<string>;
};

const IMAGES: Need = { resource: 'assistant_image', operation: 'create' };
// Anyone who may use the chat may keep notes and search their own chats.
const USE: Need = { resource: 'assistant', operation: 'update' };
const MAX_NOTE = 500;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
// For comparing a note with the message it came from.
const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.。!！]+$/, '')
    .trim();
const like = (q: string) => ({ $ilike: `%${q.replace(/[%_\\]/g, '\\$&')}%` });
const assistantOf = (ctx: Ctx) =>
  ctx.container.resolve<AssistantModuleService>(ASSISTANT_MODULE);
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

// The bank tools (owner, 2026-11-04: staff do in the chat what support did by
// hand, checked first and changed only on a tap).
type Packs = PacksModuleService;
const packsOf = (ctx: Ctx) => ctx.container.resolve<Packs>(PACKS_MODULE);

/** What the person typed: this message, and their message before it, so a
 *  change they asked for and then answered "yes" to still names its player.
 *  Both are their own words; a tool result never is. */
// Joined by a character no name, number or reason match can step over, so
// nothing is put together from the end of one message and the start of the
// other.
const staffText = (ctx: Ctx) =>
  [ctx.userText, ctx.askedBefore].filter(Boolean).join('\n\u0000\n');

/** When the permanent ban on this account began, or null for none. */
async function permanentBan(
  packs: Packs,
  customerId: string,
): Promise<{ disabled_at: Date } | null> {
  const [state] = await packs.listCustomerAccountStates(
    { customer_id: customerId, disabled: true },
    { select: ['disabled_reason', 'disabled_at'], take: 1 },
  );
  return state?.disabled_reason?.startsWith(PERMANENT_BAN_REASON_PREFIX) &&
    state.disabled_at
    ? { disabled_at: state.disabled_at }
    : null;
}

/** The last 4 as its own word in the message: digits inside a name or a phone
 *  number do not count. */
const last4Named = (text: string, last4: string) =>
  /^[0-9]{4}$/.test(last4) &&
  text.toLowerCase().split(/[^a-z0-9_-]+/).includes(last4);

/** A full number the person typed, spaced or dashed any way, standing on its
 *  own: not the tail of a name (Abc777) or of a longer number. */
const numberNamed = (text: string, key: string) =>
  /^[0-9]+$/.test(key) &&
  new RegExp(
    `(^|[^a-z0-9])0*${key.split('').join('[\\s-]*')}($|[^a-z0-9])`,
  ).test(text.toLowerCase());

/** The digits staff sent: a number may arrive unquoted. */
const digitsArg = (v: unknown) =>
  typeof v === 'number' ? String(v) : str(v).replace(/[\s-]/g, '');

/** The bank staff named, as its id: a name spelled loosely still finds it. */
const bankOf = (
  args: Record<string, unknown>,
  /** For a change: only a bank the person typed. */
  typed?: string,
): string | null => {
  const raw = str(args.bank).toLowerCase().replace(/\s+/g, '');
  if (!raw) return null;
  if (typed !== undefined && !typed.toLowerCase().replace(/\s+/g, '').includes(raw)) {
    return null;
  }
  return (
    findBank(raw)?.id ??
    [...MY_BANKS, ...SG_BANKS].find((b) =>
      b.name.toLowerCase().replace(/\s+/g, '').includes(raw),
    )?.id ??
    null
  );
};

/** The asker's role may free numbers and clear names: admins only. */
const isAdmin = async (ctx: Ctx) =>
  ctx.access.superAdmin || ((await ctx.access.can?.(BAN_LIST_NEED)) ?? false);

/** Shown name, handle and ban for each account, as the card names them. */
async function whoAre(ctx: Ctx, ids: string[]) {
  if (ids.length === 0) return [];
  const [customers, states] = await Promise.all([
    ctx.container
      .resolve<ICustomerModuleService>(Modules.CUSTOMER)
      .listCustomers(
        { id: ids },
        { select: ['id', 'first_name', 'metadata'], take: ids.length },
      ),
    packsOf(ctx).listCustomerAccountStates(
      { customer_id: ids, disabled: true },
      { select: ['customer_id', 'disabled_reason'], take: ids.length },
    ),
  ]);
  return ids.map((id) => {
    const c = customers.find((x) => x.id === id);
    const handle =
      typeof c?.metadata?.handle === 'string' ? c.metadata.handle : null;
    const shown = c?.first_name ?? handle ?? 'a deleted account';
    const banned = states.some(
      (s) =>
        s.customer_id === id &&
        s.disabled_reason?.startsWith(PERMANENT_BAN_REASON_PREFIX),
    );
    const name = `${shown}${handle && handle !== shown ? ` (@${handle})` : ''}`;
    return {
      id,
      name,
      banned,
      metadata: (c?.metadata ?? {}) as Record<string, unknown>,
      label: `${name}, ${banned ? 'banned' : 'open'}`,
    };
  });
}

/**
 * The bank number staff mean for this player: the full number, else by last 4
 * (the bank breaks a tie) among the player's own numbers (saved, paid to,
 * unbanned for them), else, for an admin, a banned one off the ban list (a
 * player whose save was refused has nothing on file). A bank only, never a
 * wallet. For a change (`write`), the number or its last 4 must be in what the
 * person typed. Never returned to the model.
 */
async function numberFor(
  ctx: Ctx,
  customerId: string,
  args: Record<string, unknown>,
  resend: string,
  write: boolean,
): Promise<{
  key: string;
  bankCode: string | null;
  last4: string;
  typed: string | null;
}> {
  const packs = packsOf(ctx);
  const text = staffText(ctx);
  // For a change, a bank the model sent but staff never typed is ignored: it
  // would choose whose rows are cut.
  const bank = bankOf(args, write ? text : undefined);
  const own = await packs.payoutAccountsOf(customerId);
  const raw = digitsArg(args.bank_account);
  if (raw) {
    const typed = payoutAccountKey(raw, false);
    if (typed.length <= 4) {
      throw new Error(
        `bank_account must be the full bank number, or left out. ${resend}`,
      );
    }
    if (write && !numberNamed(text, typed)) {
      throw new Error(
        `Use a full number only as the person typed it. ${resend}`,
      );
    }
    const mine = own.find((n) => n.account_key === typed);
    return {
      key: typed,
      bankCode: bank ?? findBank(mine?.bank_code ?? '')?.id ?? null,
      last4: typed.slice(-4),
      typed: raw,
    };
  }
  const last4 = digitsArg(args.last4);
  if (!/^[0-9]{4}$/.test(last4)) {
    throw new Error(
      `Give the last 4 digits of the bank number, or the full number. ${resend}`,
    );
  }
  if (write && !last4Named(text, last4)) {
    throw new Error(
      `Act only on a number whose last 4 the person typed. ${resend}`,
    );
  }
  const matches = own.filter(
    (n) => !n.wallet && n.account_key.slice(-4) === last4,
  );
  const key = oneNumber(own, last4, bank);
  if (key) {
    const hit = matches.find((n) => n.account_key === key);
    return {
      key,
      bankCode: bank ?? findBank(hit?.bank_code ?? '')?.id ?? null,
      last4,
      typed: null,
    };
  }
  if (matches.length > 1) {
    const banks = [
      ...new Set(matches.map((n) => findBank(n.bank_code)?.name ?? n.bank_code)),
    ].join(', ');
    throw new Error(
      `${matches.length} of this player's numbers end ${last4} (${banks}). Ask which bank. ${resend}`,
    );
  }
  const admin = await isAdmin(ctx);
  if (admin) {
    try {
      const hit = await packs.resolveBannedPayoutAccount(
        customerId,
        last4,
        bank,
        true,
      );
      return {
        key: hit.account_key,
        bankCode: bank ?? findBank(hit.bank_code)?.id ?? null,
        last4,
        typed: null,
      };
    } catch {
      // Not on the ban list either: asked for in full below.
    }
  }
  throw new Error(
    `No bank number ending ${last4} is on this player${admin ? ' or on the ban list' : ''}. Ask staff to paste the full number with the bank. ${resend}`,
  );
}

/** The holder name the player saves under: as the person typed it (for a
 *  change, as a whole phrase in what they typed), else the name on the
 *  player's saved bank (every new bank must carry it), else the real name on
 *  file when a bank would take it. Never returned to the model. */
async function holderNameFor(
  ctx: Ctx,
  customerId: string,
  args: Record<string, unknown>,
  metadata: Record<string, unknown>,
  write: boolean,
  tail: string,
): Promise<{ name: string; source: 'typed' | 'saved' | 'on_file' } | null> {
  const given = normalizeHolderName(str(args.holder_name));
  if (given) {
    if (write && !namedIn(staffText(ctx), given)) {
      throw new Error(
        `Use a holder name only as the person typed it; otherwise leave it out. ${tail}`,
      );
    }
    return { name: given, source: 'typed' };
  }
  const saved = parseSavedBankAccounts(metadata.bank_accounts)
    .filter((a) => findBank(a.bankCode)?.wallet === undefined)
    .map((a) => normalizeHolderName(a.accountHolderName ?? ''))
    .find(Boolean);
  if (saved) return { name: saved, source: 'saved' };
  const [state] = await packsOf(ctx).listCustomerAccountStates(
    { customer_id: customerId },
    { select: ['real_name'], take: 1 },
  );
  const onFile = normalizeHolderName(state?.real_name ?? '');
  return onFile && !holderNameInvalid(onFile)
    ? { name: onFile, source: 'on_file' }
    : null;
}

const NAME_SOURCE = {
  typed: 'the name you gave',
  saved: 'the name on their saved bank',
  on_file: 'the real name on file',
} as const;

/** A holder name on a card, initials only: "T** A* K**". */
const masked = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => `${w[0]}${'*'.repeat(Math.max(w.length - 1, 1))}`)
    .join(' ');

/** The reason as the person typed it, else a plain default: it lands in the
 *  audit under their name, so a bank number in it is cut out. */
const reasonOf = (args: Record<string, unknown>, ctx: Ctx, fallback: string) => {
  const given = str(args.reason).slice(0, 400);
  return given && squash(staffText(ctx)).includes(squash(given))
    ? given.replace(/\d(?:[\s.\-]*\d){4,}/g, '[number]')
    : fallback;
};

const PLAYER_ARG = {
  type: 'string',
  description:
    "The player's shown name, or their profile handle, exactly as staff wrote it (with @ when staff wrote @ for a handle).",
};
const NUMBER_ARGS = {
  last4: {
    type: 'string',
    description: 'The last 4 digits of the bank number, as staff wrote them.',
  },
  bank: {
    type: 'string',
    description:
      'The bank, e.g. Maybank or Public Bank, when staff named it or two numbers end the same.',
  },
  bank_account: {
    type: 'string',
    description:
      'The full bank number, only when staff pasted it. Leave it out otherwise.',
  },
};

/** The notes a person's chat starts with: everyone's shared notes first,
 *  then their own, each newest first, within a size budget. */
export async function memoryFor(
  assistant: AssistantModuleService,
  userId: string,
  budget = 3000,
): Promise<string[]> {
  // Shared rules first, so newer personal notes cannot push them out.
  const [shared, own] = await Promise.all([
    assistant.listAssistantMemories(
      { scope: 'shared' },
      { order: { created_at: 'DESC' }, take: 40 },
    ),
    assistant.listAssistantMemories(
      { scope: 'user', user_id: userId },
      { order: { created_at: 'DESC' }, take: 40 },
    ),
  ]);
  const out: string[] = [];
  let used = 0;
  for (const n of [...shared, ...own]) {
    const line = `${n.scope === 'shared' ? '[shared]' : '[yours]'} ${n.content}`;
    if (used + line.length > budget) break;
    out.push(line);
    used += line.length;
  }
  return out;
}

/** The person's own conversation ids, chats they deleted left out. */
async function conversationIds(ctx: Ctx): Promise<string[]> {
  const convs = await assistantOf(ctx).listAssistantConversations(
    { user_id: ctx.access.userId },
    { select: ['id'], take: 1000 },
  );
  return convs.map((c) => c.id);
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'unban_account',
    label: 'Unban',
    description:
      'Lift a permanent ban (one person with more than one account, owner 2026-11-03) when staff ask you to unban a player, by shown name or profile handle (never email or phone). Nothing changes until the person taps Unban under your answer. On unban the player can log in again and every saved bank account on it, and any name clearing, is cleared: they link a bank again themselves, under the normal rules, and a banned bank number stays banned (unban_bank_number unbans one for a player). Only a permanent ban is lifted here; a staff disable or a deleted account is handled on the admin player page. Use ban_reason first if staff want to know why it was banned.',
    parameters: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description:
            "The player's shown name, or their profile handle, exactly as staff wrote it.",
        },
        reason: {
          type: 'string',
          description:
            "Why it is lifted, in staff's words (for example: owner approved after the customer explained).",
        },
      },
      required: ['username'],
      additionalProperties: false,
    },
    needs: [UNBAN_NEED],
    run: async (args, ctx) => {
      const username = str(args.username);
      if (!username) throw new Error('username is required.');
      const packs = ctx.container.resolve<PacksModuleService>(PACKS_MODULE);
      // Only a player the person named in this very message (named.ts). A
      // shown name that is another player's handle means the banned one.
      const customerId = await namedPlayer(
        packs,
        username,
        staffText(ctx),
        'Nothing was changed.',
        {
          pick: async (byName, byHandle) => {
            const [a, b] = await Promise.all([
              permanentBan(packs, byName),
              permanentBan(packs, byHandle),
            ]);
            return a && !b ? byName : b && !a ? byHandle : null;
          },
        },
      );
      const state = await permanentBan(packs, customerId);
      if (!state) {
        throw new Error(
          `${username} has no permanent ban to lift. A staff disable or a deleted account is handled on the admin player page. Nothing was changed.`,
        );
      }
      // The card names the account as it really is, not as the model spelled it.
      const [customer] = await ctx.container
        .resolve<ICustomerModuleService>(Modules.CUSTOMER)
        .listCustomers(
          { id: customerId },
          { select: ['first_name', 'metadata'], take: 1 },
        );
      const shown = customer?.first_name ?? username;
      const handle =
        typeof customer?.metadata?.handle === 'string'
          ? customer.metadata.handle
          : null;
      // The reason lands in the audit under this person's name, so it must be
      // their own words from this message; otherwise a plain default.
      const reason = reasonOf(
        args,
        ctx,
        'Unbanned on request in the admin assistant',
      );
      proposeOrRefuse(
        ctx,
        {
          kind: 'unban',
          customer_id: customerId,
          username,
          reason,
          banned_at: new Date(state.disabled_at).toISOString(),
        },
        `Unban ${shown}${handle && handle !== shown ? ` (@${handle})` : ''}: they can log in again. Their saved bank accounts and any name clearing are cleared, so they link a bank again themselves; a banned bank number stays banned unless you also unban it for them. Reason: ${reason}`,
      );
      return JSON.stringify({
        unbanned: false,
        waiting:
          'Nothing has changed yet: an Unban button is under your answer, and the ban is lifted only when the person taps it. Tell them so in one short line, and that the player must link their bank again.',
      });
    },
  },
  {
    name: 'unban_bank_number',
    label: 'Unban bank number',
    description:
      "Unban a banned bank number for ONE player (farm-ring numbers were banned 2026-11-03) when staff ask to unban a bank number or bank account for someone: that player may then save it and be paid to it, and it stays banned for every other account. Staff must name, in one message, the player it is for (shown name or profile handle) and the number's last 4 digits; pass the bank only when two banned numbers end the same. For an admin the player can be the one whose save was refused (the number need not be on their account); for anyone else the number must be on that player's banks or payouts, so do it before an account unban, which clears the saved banks. Nothing changes until the person taps the button under your answer. If another account holds the number, the player's own save is still refused as shared: free_bank_number (admins) takes it off them. ban_reason shows a player's banned numbers; bank_save_check, what still blocks a save.",
    parameters: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description:
            'The player the number is unbanned for: shown name or profile handle, exactly as staff wrote it.',
        },
        last4: {
          type: 'string',
          description:
            'The last 4 digits of the bank number, as staff wrote them.',
        },
        bank: {
          type: 'string',
          description:
            'The bank, e.g. Maybank or Public Bank, only when two banned numbers end the same.',
        },
        reason: {
          type: 'string',
          description: "Why it is unbanned, in staff's words.",
        },
      },
      required: ['username', 'last4'],
      additionalProperties: false,
    },
    needs: [UNBAN_NEED],
    run: async (args, ctx) => {
      const resend =
        'Ask them to send it again in one message with the player and the last 4, for example: "unban Maybank 2135 for Collector123". Nothing was changed.';
      const username = str(args.username);
      // The model may send the digits unquoted.
      const last4 =
        typeof args.last4 === 'number' ? String(args.last4) : str(args.last4);
      if (!username) throw new Error(`username is required. ${resend}`);
      if (!/^[0-9]{4}$/.test(last4)) {
        throw new Error(
          `last4 must be the last 4 digits of the bank number. ${resend}`,
        );
      }
      // Only what the person typed, so data the model read (a customer field,
      // a past chat) cannot start one; the last 4 as its own word, so digits
      // inside a name or a phone number do not count.
      const text = staffText(ctx);
      if (!namedIn(text, username) || !last4Named(text, last4)) {
        throw new Error(
          `Unban a bank number only when the person names, in this message, the player it is for and its last 4 digits. ${resend}`,
        );
      }
      const packs = ctx.container.resolve<PacksModuleService>(PACKS_MODULE);
      const customerId = await namedPlayer(packs, username, text, resend);
      // The bank only breaks a tie: a name the model or staff spelled loosely
      // must not refuse a number its last 4 already names.
      const bank = bankOf(args);
      let hit;
      try {
        hit = await packs.resolveBannedPayoutAccount(
          customerId,
          last4,
          bank,
          ctx.access.superAdmin ||
            ((await ctx.access.can?.(BAN_LIST_NEED)) ?? false),
        );
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)} ${resend}`,
        );
      }
      // The card names the account as it really is, not as the model spelled it.
      const [customer] = await ctx.container
        .resolve<ICustomerModuleService>(Modules.CUSTOMER)
        .listCustomers(
          { id: customerId },
          { select: ['first_name', 'metadata'], take: 1 },
        );
      const shown = customer?.first_name ?? username;
      const handle =
        typeof customer?.metadata?.handle === 'string'
          ? customer.metadata.handle
          : null;
      const bankName =
        findBank(hit.bank_code)?.name ?? (hit.bank_code || 'the bank');
      const reason = reasonOf(
        args,
        ctx,
        'Bank number unbanned on request in the admin assistant',
      );
      proposeOrRefuse(
        ctx,
        {
          kind: 'unban_number',
          customer_id: customerId,
          username,
          bank_code: hit.bank_code,
          last4,
          reason,
        },
        `Unban ${bankName} …${last4} for ${shown}${handle && handle !== shown ? ` (@${handle})` : ''} only: they may save it and be paid to it; it stays banned for every other account. If another account holds it, it also needs freeing from them (an admin). Reason: ${reason}`,
      );
      return JSON.stringify({
        unbanned: false,
        waiting:
          'Nothing has changed yet: a button is under your answer, and the number is unbanned for this player only when the person taps it. Tell them so in one short line; if another account holds the number, bank_save_check says so and free_bank_number (admins) frees it.',
      });
    },
  },
  {
    name: 'bank_save_check',
    label: 'Why a bank save is refused',
    description:
      "Check, the way the app checks a player's own save, why a player cannot add (save, link) a bank account, and what fixes each block (owner, 2026-11-04). Use it whenever staff say a player cannot add a bank or is refused, before proposing unban_bank_number, free_bank_number or clear_name_clash, and again when staff say they tapped one, to confirm it worked. Give the player (shown name or profile handle; '@name' means the handle), the bank, and the number's last 4, or the full number if staff pasted it (in this chat; pass it again to re-check); holder_name only if staff typed the name the player saves under (otherwise the name on their saved bank, then the real name on file, is used). `fixes` lists each block with the tool that fixes it, in order; `unchecked` what it could not check. can_save true means nothing blocks, false that something does, null that a part was not checked. Explain it in plain words; never repeat a full number or a holder name back.",
    parameters: {
      type: 'object',
      properties: {
        username: PLAYER_ARG,
        ...NUMBER_ARGS,
        holder_name: {
          type: 'string',
          description:
            'The holder name the player saves under, only when staff typed it.',
        },
      },
      required: ['username'],
      additionalProperties: false,
    },
    // What ban_reason reads: bank and last 4 only, other accounts by name.
    needs: [
      { resource: 'customer', operation: 'read' },
      { resource: 'payment', operation: 'read' },
    ],
    run: async (args, ctx) => {
      const packs = packsOf(ctx);
      const again = 'Ask staff for the player, the bank and the number again.';
      const customerId = await namedPlayer(
        packs,
        str(args.username),
        staffText(ctx),
        again,
        { readOnly: true },
      );
      const admin = await isAdmin(ctx);
      const forAdmin = (fix: string) =>
        admin ? fix : `${fix} Only an admin can do this: your role cannot.`;
      const [me] = await whoAre(ctx, [customerId]);
      const saved = parseSavedBankAccounts(me.metadata.bank_accounts);
      const fixes: string[] = [];
      const unchecked: string[] = [];
      if (me.banned) {
        fixes.push(
          'The account is permanently banned: unban_account. An unban clears its saved banks and any name clearing, so clear_name_clash comes after it.',
        );
      }
      const out: Record<string, unknown> = {
        player: me.label,
        saved_banks: saved.map((a) => ({
          bank: a.bankName,
          last4: a.accountNumber.slice(-4),
        })),
      };
      const holder = await holderNameFor(
        ctx,
        customerId,
        args,
        me.metadata,
        false,
        again,
      );
      let number: Awaited<ReturnType<typeof numberFor>> | null = null;
      if (digitsArg(args.last4) || digitsArg(args.bank_account)) {
        try {
          number = await numberFor(ctx, customerId, args, again, false);
        } catch (err) {
          out.number = {
            not_checked: err instanceof Error ? err.message : String(err),
          };
          unchecked.push('the number');
        }
      } else {
        unchecked.push('the number: give its bank and last 4 to check it');
      }
      let numberHolders: string[] = [];
      if (number) {
        const bank = number.bankCode ? findBank(number.bankCode) : undefined;
        const bannedForPlayer = await packs.payoutAccountBanned(
          number.key,
          false,
          customerId,
        );
        const banned =
          bannedForPlayer ||
          (await packs.payoutAccountBanned(number.key, false));
        if (
          bank &&
          saved.some(
            (a) =>
              findBank(a.bankCode)?.id === bank.id &&
              payoutAccountKey(a.accountNumber, false) === number?.key,
          )
        ) {
          // A save of what is already theirs is a no-op that succeeds.
          return JSON.stringify({
            ...out,
            number: { bank: bank.name, last4: number.last4, already_saved: true },
            fixes: [],
            unchecked: [],
            can_save: true,
          });
        }
        if (bannedForPlayer) {
          fixes.push(
            `…${number.last4} is banned for this player: unban_bank_number unbans it for them only.`,
          );
        }
        if (!bank) {
          out.number = {
            last4: number.last4,
            banned,
            banned_for_this_player: bannedForPlayer,
            not_checked: 'which bank it is at',
          };
          unchecked.push(
            'who else holds the number, and the slot: ask staff which bank, then check again',
          );
        } else {
          numberHolders = await packs.payoutAccountHoldersAt(
            customerId,
            number.key,
            bank.id,
          );
          const others = await whoAre(ctx, numberHolders);
          out.number = {
            bank: bank.name,
            last4: number.last4,
            banned,
            banned_for_this_player: bannedForPlayer,
            other_accounts: others.map((o) => o.label),
            blocks_save: bannedForPlayer || others.length > 0,
          };
          if (others.length > 0) {
            fixes.push(
              forAdmin(
                `${bank.name} …${number.last4} is on ${others.length} other account${others.length === 1 ? '' : 's'} (${others.map((o) => o.label).join('; ')}): free_bank_number takes it off them so this player can save it.`,
              ),
            );
          }
          if (savedSlotFull(saved, bank.id)) {
            fixes.push(
              'The player already has a bank saved in that slot: support removes it on the admin player page first.',
            );
          }
          if (holder && holderUnlikeSaved(saved, bank.id, holder.name)) {
            fixes.push(
              'A different holder name is already saved on this account: a new bank must use it, or support adds the bank on the admin player page.',
            );
          }
          // Lengths and patterns per bank need the number as typed: a stored
          // key has lost any leading zero.
          const invalid =
            number.typed && holder
              ? withdrawalDetailsError({
                  bankCode: bank.id,
                  accountNumber: number.typed,
                  accountHolderName: holder.name,
                })
              : null;
          if (invalid) fixes.push(`The save would be refused: ${invalid}`);
        }
      }
      if (!holder) {
        out.name = 'not checked';
        unchecked.push(
          'the holder name: none is saved or on file that a bank takes; ask staff for the name the player saves under',
        );
      } else {
        const holders = await packs.holderNameHolders(customerId, holder.name);
        const cleared =
          clearedHolderNames(me.metadata)[holderNameKey(holder.name)]?.with ??
          [];
        const others = await whoAre(ctx, holders);
        const blocking = others.filter((o) => !cleared.includes(o.id));
        out.name = {
          checked: NAME_SOURCE[holder.source],
          format_ok: !holderNameInvalid(holder.name),
          other_accounts: others.map((o) => ({
            account: o.label,
            cleared_for_this_player: cleared.includes(o.id),
          })),
          blocks_save: blocking.length > 0,
        };
        if (holderNameInvalid(holder.name)) {
          fixes.push(`The name would be refused: ${HOLDER_NAME_INVALID_MESSAGE}`);
        }
        if (blocking.length > 0) {
          const viaNumber = blocking.some((o) => numberHolders.includes(o.id));
          fixes.push(
            forAdmin(
              `The name is used by ${blocking.length} other account${blocking.length === 1 ? '' : 's'} (${blocking.map((o) => o.label).join('; ')}). ${viaNumber ? 'Freeing the number may free it too: free it, check again, then ' : ''}clear_name_clash for whoever still holds it, once staff confirm they are different people or the owner allowed it.`,
            ),
          );
        }
      }
      return JSON.stringify({
        ...out,
        fixes,
        unchecked,
        can_save: fixes.length > 0 ? false : unchecked.length > 0 ? null : true,
      });
    },
  },
  {
    name: 'account_links',
    label: 'Accounts that may be one person',
    description:
      "Other accounts that may belong to the same person, by what is not a bank (owner, 2026-11-06): the same browser or network (IP) seen on both, a saved delivery address that matches, and real names that are one name or where one starts the other. Use it together with ban_reason whenever staff ask whether accounts are related, linked or one person (有关系, 同一个人, same person): ban_reason sees bank numbers and holder names only. Give the player by shown name or profile handle ('@name' means the handle); for two accounts, call it for one and look for the other in its list. These are review signals, never proof and never a ban reason. Say what matched in plain words (the same browser, a network only these two used, the same delivery address, near-identical real names); never repeat an address, IP or real name. If nothing matched, say no signal was found, never that the accounts are unrelated or independent; if checked.browser_and_network is false, say browser and network were not checked.",
    parameters: {
      type: 'object',
      properties: { username: PLAYER_ARG },
      required: ['username'],
      additionalProperties: false,
    },
    // Address and real name are on the admin player page; browser and network
    // are fenced like bank details, so that part is checked when it runs.
    needs: [{ resource: 'customer', operation: 'read' }],
    run: async (args, ctx) => {
      const packs = packsOf(ctx);
      const customerId = await namedPlayer(
        packs,
        str(args.username),
        staffText(ctx),
        'Ask staff for the player again.',
        { readOnly: true },
      );
      const visitors =
        ctx.access.superAdmin ||
        ((await ctx.access.can?.(VISITOR_NEED)) ?? false);
      const [me] = await whoAre(ctx, [customerId]);
      return JSON.stringify({
        player: me.label,
        ...(await accountLinks({
          db: ctx.container.resolve<LinksDb>(
            ContainerRegistrationKeys.PG_CONNECTION,
          ),
          packs,
          customerId,
          adminId: ctx.access.userId,
          visitors,
          label: (ids) => whoAre(ctx, ids),
        })),
      });
    },
  },
  {
    name: 'free_bank_number',
    label: 'Free bank number',
    description:
      "Take a bank number off every OTHER account at that bank that saved it or was paid to it, so the player staff name can save it themselves (owner, 2026-11-04). Use it when staff ask to free the number or to let the player add it, naming the player, the bank and the number's last 4 (or pasting it in full); run bank_save_check first. Those accounts lose their saved entry of it, and their payouts to it keep the last 4 only, with no name: this cannot be undone, and it is audited. It does not unban the number (unban_bank_number) or the account (unban_account; its card comes first). Nothing changes until the person taps the button under your answer. Admins only.",
    parameters: {
      type: 'object',
      properties: {
        username: PLAYER_ARG,
        ...NUMBER_ARGS,
        reason: { type: 'string', description: "Why, in staff's words." },
      },
      required: ['username'],
      additionalProperties: false,
    },
    needs: [UNBAN_NEED, BAN_LIST_NEED],
    run: async (args, ctx) => {
      const resend =
        'Ask them to send it again with the player, the bank and the last 4, for example: "free Maybank 0001 for Collector123". Nothing was changed.';
      const packs = packsOf(ctx);
      const customerId = await namedPlayer(
        packs,
        str(args.username),
        staffText(ctx),
        resend,
      );
      const n = await numberFor(ctx, customerId, args, resend, true);
      const bank = n.bankCode ? findBank(n.bankCode) : undefined;
      if (!bank || bank.wallet !== undefined) {
        throw new Error(
          `Which bank is …${n.last4} at? Ask staff to name the bank. Nothing was changed.`,
        );
      }
      const ids = await packs.payoutAccountHoldersAt(customerId, n.key, bank.id);
      if (ids.length === 0) {
        throw new Error(
          `No other account holds ${bank.name} …${n.last4}, so there is nothing to free. Run bank_save_check for what blocks the save. Nothing was changed.`,
        );
      }
      const [me, ...others] = await whoAre(ctx, [customerId, ...ids]);
      const reason = reasonOf(
        args,
        ctx,
        'Bank number freed on request in the admin assistant',
      );
      proposeOrRefuse(
        ctx,
        {
          kind: 'free_number',
          customer_id: customerId,
          username: str(args.username),
          bank_code: bank.id,
          last4: n.last4,
          number_mark: numberMark(n.key, ctx.container),
          from: ids,
          reason,
        },
        `${me.banned ? 'Tap Unban first: this works once the player is unbanned. ' : ''}Free ${bank.name} …${n.last4} for ${me.name}: it comes off ${others.length} other account${others.length === 1 ? '' : 's'}: ${others.map((o) => o.label).join('; ')}. They lose their saved entry of it, and their payouts to it keep the last 4 only, with no name. This cannot be undone. The player then saves it themselves${(await packs.payoutAccountBanned(n.key, false, customerId)) ? ', once it is also unbanned for them' : ''}. Reason: ${reason}`,
      );
      return JSON.stringify({
        freed: false,
        waiting:
          'Nothing has changed yet: a Free bank number button is under your answer, and the number comes off those accounts only when the person taps it. Tell them so in one short line, that it cannot be undone, and to tell you once they tapped it so you check again.',
      });
    },
  },
  {
    name: 'clear_name_clash',
    label: 'Clear shared name',
    description:
      "Let a player save banks under a holder name other accounts also used, when staff ask, naming the player, after they checked these are different people or the owner allowed it (owner, 2026-11-04). The name is the one staff typed, else the name on the player's saved bank, else the real name on file. Every other account using it now is listed on the card, any number of them; only those stop counting against this player's saves, and an account that uses the name later still does. If the name is on a number's payout rows, free_bank_number may free it first: check again (bank_save_check) before this. An account unban clears this, so its card comes first. Nothing changes until the person taps the button under your answer. Admins only.",
    parameters: {
      type: 'object',
      properties: {
        username: PLAYER_ARG,
        holder_name: {
          type: 'string',
          description: 'The holder name, only when staff typed it.',
        },
        reason: { type: 'string', description: "Why, in staff's words." },
      },
      required: ['username'],
      additionalProperties: false,
    },
    needs: [UNBAN_NEED, BAN_LIST_NEED],
    run: async (args, ctx) => {
      const packs = packsOf(ctx);
      const tail = 'Nothing was changed.';
      const customerId = await namedPlayer(
        packs,
        str(args.username),
        staffText(ctx),
        tail,
      );
      const [me] = await whoAre(ctx, [customerId]);
      const holder = await holderNameFor(
        ctx,
        customerId,
        args,
        me.metadata,
        true,
        tail,
      );
      if (!holder) {
        throw new Error(
          `No holder name is saved or on file for this player that a bank takes: ask staff to type the name with the player. ${tail}`,
        );
      }
      if (holderNameInvalid(holder.name)) {
        throw new Error(`${HOLDER_NAME_INVALID_MESSAGE} ${tail}`);
      }
      const holders = await packs.holderNameHolders(customerId, holder.name);
      const cleared =
        clearedHolderNames(me.metadata)[holderNameKey(holder.name)]?.with ?? [];
      if (holders.length === 0) {
        throw new Error(
          `No other account uses this name, so there is nothing to clear. ${tail}`,
        );
      }
      if (holders.every((id) => cleared.includes(id))) {
        throw new Error(
          `The name is already cleared for every account that uses it. ${tail}`,
        );
      }
      const others = await whoAre(ctx, holders);
      const reason = reasonOf(
        args,
        ctx,
        'Shared holder name cleared on request in the admin assistant',
      );
      proposeOrRefuse(
        ctx,
        {
          kind: 'name_clash',
          customer_id: customerId,
          username: str(args.username),
          holder_name: holder.name,
          with: holders,
          reason,
        },
        `${me.banned ? 'Tap Unban first: an unban clears this. ' : ''}Clear ${NAME_SOURCE[holder.source]} (${masked(holder.name)}) for ${me.name}: ${others.length} other account${others.length === 1 ? '' : 's'} use it: ${others.map((o) => o.label).join('; ')}. Their use of it stops blocking this player's bank saves; an account that uses it later still does. It can be taken back on the admin player page. Reason: ${reason}`,
      );
      return JSON.stringify({
        cleared: false,
        waiting:
          'Nothing has changed yet: a Clear name button is under your answer, and the name is cleared only when the person taps it. Tell them so in one short line, and to tell you once they tapped it so you check again.',
      });
    },
  },
  {
    name: 'remember',
    label: 'Remember',
    description:
      'Save a note to remember in later chats: a fact, a preference or a rule staff told you ("captions always end with the website", "Crazy Sunday runs 10pm to midnight"). Keep it one short sentence. shared true makes it everyone\'s note (super admins only, and only the admin\'s own words from this message, copied exactly); otherwise only this person sees it. Save only what staff asked you to remember or clearly want kept, never passwords, keys or customer details.',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'The note, one sentence, up to 500 characters.',
        },
        shared: {
          type: 'boolean',
          description: 'true: a note for everyone (super admins only).',
        },
      },
      required: ['note'],
      additionalProperties: false,
    },
    needs: [USE],
    run: async (args, ctx) => {
      const note = str(args.note);
      if (!note) throw new Error('note is required.');
      if (note.length > MAX_NOTE) {
        throw new Error(`A note is at most ${MAX_NOTE} characters.`);
      }
      const shared = args.shared === true || args.shared === 'true';
      if (shared && !ctx.access.superAdmin) {
        throw new Error(
          'Only an admin can save a note for everyone; saved nothing.',
        );
      }
      // A note for everyone lands in every chat's instructions, so it must be
      // the admin's own words from this message, not text an earlier answer
      // or a customer field put in front of the model. (The engine already
      // refuses every lasting write once tool output is in the turn.)
      if (shared && !squash(ctx.userText ?? '').includes(squash(note))) {
        throw new Error(
          "A note for everyone must be the admin's own words from this message, copied exactly. Saved nothing.",
        );
      }
      proposeOrRefuse(
        ctx,
        { kind: 'note', note, shared },
        `${shared ? 'Note for everyone' : 'Note'}: ${note}`,
      );
      return JSON.stringify({ saved: false, waiting: WAITING, shared });
    },
  },
  {
    name: 'recall',
    label: 'Memory',
    description:
      "Look through the saved notes: everyone's shared notes and this person's own. query narrows them to notes containing the words; no query lists the newest. The newest notes are already in your instructions; use this for older ones.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for.' },
      },
      additionalProperties: false,
    },
    needs: [USE],
    run: async (args, ctx) => {
      const q = str(args.query);
      const notes = await assistantOf(ctx).listAssistantMemories(
        {
          $or: [
            { scope: 'shared' },
            { scope: 'user', user_id: ctx.access.userId },
          ],
          ...(q ? { content: like(q) } : {}),
        },
        { order: { created_at: 'DESC' }, take: 30 },
      );
      return JSON.stringify(
        notes.map((n) => ({
          id: n.id,
          shared: n.scope === 'shared',
          note: n.content,
          saved: day(n.created_at),
        })),
      );
    },
  },
  {
    name: 'forget',
    label: 'Forget',
    description:
      'Delete a saved note by its id (from recall), when staff say it is wrong or no longer true. A person can delete their own notes; shared notes only an admin.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note id from recall.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    needs: [USE],
    run: async (args, ctx) => {
      const id = str(args.id);
      const assistant = assistantOf(ctx);
      const [note] = await assistant.listAssistantMemories({ id }, { take: 1 });
      const mine =
        note && note.scope === 'user' && note.user_id === ctx.access.userId;
      if (!note || (!mine && !ctx.access.superAdmin)) {
        throw new Error('No such note of yours.');
      }
      // A shared note or someone else's goes only on the admin's own say-so:
      // its id typed or pasted in this message, not one an earlier answer
      // printed and later text steered the model back to.
      if (!mine && !(ctx.userText ?? '').includes(note.id)) {
        throw new Error(
          `To delete a shared note or someone else's, the admin must put its id (${note.id}) in their message. Deleted nothing.`,
        );
      }
      await assistant.softDeleteAssistantMemories([note.id]);
      return JSON.stringify({ deleted: true, id: note.id });
    },
  },
  {
    name: 'search_chats',
    label: 'Past chats',
    description:
      'Search earlier assistant chats for a word or phrase: what was asked, what was answered, and the images made (their URLs, which the image tools can reuse). Use it when staff refer to something from before ("the poster we made last week", "what did you tell me about the challenge"). Searches only this person\'s own chats.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A word or phrase to look for.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    needs: [USE],
    run: async (args, ctx) => {
      const q = str(args.query);
      if (!q) throw new Error('query is required.');
      const ids = await conversationIds(ctx);
      if (!ids.length) return '[]';
      const assistant = assistantOf(ctx);
      const hits = await assistant.listAssistantMessages(
        { content: like(q), conversation_id: ids },
        { order: { created_at: 'DESC' }, take: 20 },
      );
      const convs = hits.length
        ? await assistant.listAssistantConversations({
            id: [...new Set(hits.map((h) => h.conversation_id))],
          })
        : [];
      const title = new Map(convs.map((c) => [c.id, c.title]));
      return JSON.stringify(
        hits.map((h) => {
          const at = h.content.toLowerCase().indexOf(q.toLowerCase());
          const from = Math.max(0, at - 120);
          return {
            date: day(h.created_at),
            chat: title.get(h.conversation_id) ?? '',
            who: h.role === 'user' ? 'staff' : 'assistant',
            text: `${from > 0 ? '…' : ''}${h.content.slice(from, from + 360)}`,
            images: Array.isArray(h.images)
              ? (h.images as { url: string }[]).map((i) => i.url)
              : [],
          };
        }),
      );
    },
  },
  {
    name: 'find_assets',
    label: 'Find assets',
    description:
      'Find art to build a post with: kind pack = pack art (each pack\'s portrait image and its stage image), card = card pictures and their PSA slab images, made = images and posters the assistant made before, any = all three. query is a name or word ("151", "Charizard", "lossless"). Returns URLs: pass one as marketing_poster\'s feature_url to stand the real pack or slab in the poster, or as reference_urls of generate_image or marketing_poster to use it as a reference. Never describe a pack or card to the image model when its real art exists.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A name or word.' },
        kind: {
          type: 'string',
          enum: ['pack', 'card', 'made', 'any'],
          description: 'Default any.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    // pack:read too: listPacks has no status filter, so it shows draft packs.
    needs: [IMAGES, { resource: 'pack', operation: 'read' }],
    run: async (args, ctx) => {
      const q = str(args.query);
      if (!q) throw new Error('query is required.');
      const kind = str(args.kind) || 'any';
      const packs = ctx.container.resolve<PacksModuleService>(PACKS_MODULE);
      const found: Record<string, unknown>[] = [];
      if (kind === 'pack' || kind === 'any') {
        const rows = await packs.listPacks(
          { $or: [{ title: like(q) }, { slug: like(q) }] },
          {
            take: 8,
            select: ['title', 'slug', 'status', 'image', 'display_image'],
          },
        );
        for (const p of rows) {
          found.push({
            kind: 'pack',
            name: p.title,
            slug: p.slug,
            status: p.status,
            url: p.image,
            stage_url: p.display_image ?? null,
          });
        }
      }
      if (kind === 'card' || kind === 'any') {
        const rows = await packs.listCards(
          { name: like(q) },
          {
            take: 8,
            select: ['name', 'handle', 'grade', 'image', 'slab_image'],
          },
        );
        for (const c of rows) {
          found.push({
            kind: 'card',
            name: c.name,
            grade: c.grade ?? null,
            url: c.slab_image || c.image,
            card_url: c.image,
          });
        }
      }
      if (kind === 'made' || kind === 'any') {
        const ids = await conversationIds(ctx);
        const assistant = assistantOf(ctx);
        const convs = await assistant.listAssistantConversations(
          { title: like(q), id: ids },
          { select: ['id', 'title'], take: 20 },
        );
        const byTitle = new Map(convs.map((c) => [c.id, c.title]));
        const made = await assistant.listAssistantMessages(
          {
            role: 'assistant',
            images: { $ne: null },
            $or: [
              { content: like(q) },
              ...(byTitle.size
                ? [{ conversation_id: [...byTitle.keys()] }]
                : []),
            ],
            conversation_id: ids,
          },
          { order: { created_at: 'DESC' }, take: 8 },
        );
        for (const m of made) {
          for (const img of (m.images as { url: string }[] | null) ?? []) {
            found.push({
              kind: 'made',
              url: img.url,
              made_on: day(m.created_at),
              for: byTitle.get(m.conversation_id) ?? m.content.slice(0, 120),
            });
          }
        }
      }
      return JSON.stringify(found.slice(0, 20));
    },
  },
  {
    name: 'schedule_task',
    label: 'Schedule task',
    description: `Set a task you will do by yourself every day or every week at a set Malaysia time, as this person and with their access ("every morning at 9 send me yesterday's top hits", "every Monday 10am make the leaderboard poster"). Each run's answer lands in one chat of theirs titled with the task. instruction is the full request as you would want it at run time: everything needed, no "same as before". At most ${MAX_SCHEDULES} tasks per person. Confirm the time and the instruction with them before setting it unless they already said both.`,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'A short name, up to 80 characters.',
        },
        instruction: {
          type: 'string',
          description: 'What to do at each run, up to 1000 characters.',
        },
        every: { type: 'string', enum: ['day', 'week'] },
        time: {
          type: 'string',
          description: 'HH:MM, 24-hour, Malaysia time (e.g. "09:00", "22:30").',
        },
        weekday: {
          type: 'integer',
          minimum: 1,
          maximum: 7,
          description: 'For every week: 1 Monday … 7 Sunday.',
        },
      },
      required: ['title', 'instruction', 'every', 'time'],
      additionalProperties: false,
    },
    needs: [USE],
    run: async (args, ctx) => {
      const title = str(args.title);
      const instruction = str(args.instruction);
      const every = str(args.every);
      const at_time = str(args.time).padStart(5, '0');
      if (!title || title.length > 80)
        throw new Error('title: 1 to 80 characters.');
      if (!instruction || instruction.length > 1000) {
        throw new Error('instruction: 1 to 1000 characters.');
      }
      if (every !== 'day' && every !== 'week') {
        throw new Error('every must be "day" or "week".');
      }
      const weekday = every === 'week' ? Number(args.weekday ?? 1) : null;
      const next_run_at = nextRun({ every, at_time, weekday }, new Date());
      const assistant = assistantOf(ctx);
      const [, count] = await assistant.listAndCountAssistantSchedules(
        { user_id: ctx.access.userId },
        { take: 1 },
      );
      if (count >= MAX_SCHEDULES) {
        throw new Error(
          `This person already has ${MAX_SCHEDULES} scheduled tasks; cancel one first. Set nothing.`,
        );
      }
      proposeOrRefuse(
        ctx,
        { kind: 'schedule', title, instruction, every, at_time, weekday },
        `${
          every === 'week'
            ? `Every ${WEEKDAYS[(weekday ?? 1) - 1]} ${at_time}`
            : `Every day ${at_time}`
        } (Malaysia time) · ${title}: ${instruction}`,
      );
      return JSON.stringify({
        scheduled: false,
        waiting: WAITING,
        first_run_if_saved_now: myt(next_run_at),
      });
    },
  },
  {
    name: 'list_schedules',
    label: 'Scheduled tasks',
    description:
      "List this person's scheduled tasks: when each runs next, when it last ran, and its last error if the run failed. everyone true lists every staff member's (admins only).",
    parameters: {
      type: 'object',
      properties: {
        everyone: {
          type: 'boolean',
          description: "true: every staff member's tasks (admins only).",
        },
      },
      additionalProperties: false,
    },
    needs: [USE],
    run: async (args, ctx) => {
      const all =
        (args.everyone === true || args.everyone === 'true') &&
        ctx.access.superAdmin;
      const rows = await assistantOf(ctx).listAssistantSchedules(
        all ? {} : { user_id: ctx.access.userId },
        { order: { next_run_at: 'ASC' }, take: 50 },
      );
      return JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          ...(all ? { staff: r.user_id } : {}),
          title: r.title,
          instruction: r.instruction,
          when:
            r.every === 'week'
              ? `every ${WEEKDAYS[(r.weekday ?? 1) - 1]} ${r.at_time} MYT`
              : `every day ${r.at_time} MYT`,
          next_run: myt(r.next_run_at),
          last_run: r.last_run_at ? myt(r.last_run_at) : null,
          last_error: r.last_error,
        })),
      );
    },
  },
  {
    name: 'cancel_schedule',
    label: 'Cancel task',
    description:
      "Stop a scheduled task for good, by its id from list_schedules. A person can cancel their own; an admin anyone's.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id from list_schedules.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    needs: [USE],
    run: async (args, ctx) => {
      const id = str(args.id);
      const assistant = assistantOf(ctx);
      const [task] = await assistant.listAssistantSchedules(
        { id },
        { take: 1 },
      );
      if (
        !task ||
        (task.user_id !== ctx.access.userId && !ctx.access.superAdmin)
      ) {
        throw new Error('No such scheduled task of yours.');
      }
      // Someone else's task goes only when the admin typed or pasted its id.
      if (
        task.user_id !== ctx.access.userId &&
        !(ctx.userText ?? '').includes(task.id)
      ) {
        throw new Error(
          `To cancel someone else's task, the admin must put its id (${task.id}) in their message. Cancelled nothing.`,
        );
      }
      await assistant.softDeleteAssistantSchedules([task.id]);
      return JSON.stringify({
        cancelled: true,
        id: task.id,
        title: task.title,
      });
    },
  },
];

const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
/** "2026-10-30 09:00 MYT" */
const myt = (d: Date | string) =>
  `${new Date(new Date(d).getTime() + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} MYT`;

/** Image URLs staff or find_assets gave, as data URLs for the image model
 *  (our CDN, the storefront, or the local file store; SSRF-guarded by
 *  fetchBytes). One that cannot be read throws, naming it. */
export async function assetDataUrls(
  urls: unknown,
  container: MedusaContainer,
  max = 4,
): Promise<string[]> {
  const list = Array.isArray(urls)
    ? urls.filter((u): u is string => typeof u === 'string')
    : [];
  if (list.length > max) throw new Error(`At most ${max} reference images.`);
  return Promise.all(
    list.map(async (url) => {
      const bytes = await assetBytes(url, container);
      const jpeg = await sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS })
        .resize({
          width: 768,
          height: 768,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .flatten({ background: '#0a0a0a' })
        .jpeg({ quality: 82 })
        .toBuffer();
      return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    }),
  );
}

// Where the assistant may fetch images from: our sites, media CDN and file
// store, or a URL a pack or card already holds. fetchBytes alone allows every
// public host, so a URL the model wrote (say, after reading a customer field
// that told it to) could carry what it read to any server (security review
// 2026-10-29).
const OWN_SITES = ['https://polycards.gg', 'https://www.polycards.gg'];
// admin.polycards.gg is the backend itself: only its public card images.
const BACKEND_SITE = 'https://admin.polycards.gg';
const originOf = (u: string | null | undefined) => {
  try {
    return u ? new URL(u).origin : null;
  } catch {
    return null;
  }
};

export const isOwnOrigin = (url: string) => {
  const origin = originOf(url);
  if (origin === BACKEND_SITE) {
    try {
      return new URL(url).pathname.startsWith('/cdn/');
    } catch {
      return false;
    }
  }
  return (
    origin !== null &&
    // Never the backend's own origin (a GET there runs routes on the model's
    // say-so); its file store only in dev, when uploads live there.
    [...OWN_SITES, process.env.S3_FILE_URL, localFileOrigin(), assetOrigin()]
      .map(originOf)
      .includes(origin)
  );
};

export async function isOwnAsset(
  url: string,
  container: MedusaContainer,
): Promise<boolean> {
  if (/^\/(?!\/)/.test(url)) return true; // storefront-relative
  if (!originOf(url)) return false;
  if (isOwnOrigin(url)) return true;
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const held = await packs.listPacks(
    { $or: [{ image: url }, { display_image: url }] },
    { take: 1, select: ['slug'] },
  );
  if (held.length) return true;
  const cards = await packs.listCards(
    { $or: [{ image: url }, { slab_image: url }] },
    { take: 1, select: ['handle'] },
  );
  return cards.length > 0;
}

/** One asset's bytes, or an error naming it. */
export async function assetBytes(
  url: string,
  container: MedusaContainer,
): Promise<Buffer> {
  if (!(await isOwnAsset(url, container))) {
    throw new Error(
      `Not one of our images: ${url.slice(0, 120)}. Use find_assets, past chat images or an attached screenshot.`,
    );
  }
  const reasons: string[] = [];
  // Every redirect stays on our hosts or the host this URL already named.
  const start = url.startsWith('/') ? `${assetOrigin()}${url}` : url;
  const bytes = await fetchBytes(
    url,
    (r) => reasons.push(r),
    (hop) => isOwnOrigin(hop) || originOf(hop) === originOf(start),
  );
  if (!bytes) {
    throw new Error(
      `Could not load ${url.slice(0, 120)}: ${reasons[0] ?? 'unknown'}.`,
    );
  }
  return bytes;
}
