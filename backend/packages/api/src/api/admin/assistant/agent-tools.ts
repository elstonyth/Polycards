import type {
  ICustomerModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';
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
import { BAN_LIST_NEED, UNBAN_NEED, type Proposal } from './confirm';
import { PERMANENT_BAN_REASON_PREFIX } from '../../../modules/packs/saved-accounts';
import { MY_BANKS, SG_BANKS, findBank } from '../../../modules/packs/banks';
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
      'Lift a permanent ban (one person with more than one account, owner 2026-11-03) when staff ask you to unban a player, by shown name or profile handle (never email or phone). Nothing changes until the person taps Unban under your answer. On unban the player can log in again and every saved bank account on it is cleared: they link a bank again themselves, under the normal rules, and a banned bank number stays banned (unban_bank_number unbans one for a player). Only a permanent ban is lifted here; a staff disable or a deleted account is handled on the admin player page. Use ban_reason first if staff want to know why it was banned.',
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
      // Only a player the person named in this very message, as a whole word: a
      // name in data the model read (a customer field, a past chat) must not
      // start one, and Collector1 must not match a message naming Collector12.
      const words = (ctx.userText ?? '').toLowerCase().split(/[^a-z0-9_-]+/);
      if (!words.includes(username.toLowerCase())) {
        throw new Error(
          'Unban only a player the person named in this message. Nothing was changed.',
        );
      }
      const packs = ctx.container.resolve<PacksModuleService>(PACKS_MODULE);
      const byName = await packs.findCustomerIdByUsername(username);
      const byHandle = await packs.findCustomerIdByHandle(username);
      if (byName && byHandle && byName !== byHandle) {
        throw new Error(
          `${username} is a shown name and a different player's handle. Ask staff for the name shown on the profile. Nothing was changed.`,
        );
      }
      const customerId = byName ?? byHandle;
      if (!customerId) {
        throw new Error(`No player named ${username}. Nothing was changed.`);
      }
      const [state] = await packs.listCustomerAccountStates(
        { customer_id: customerId, disabled: true },
        { select: ['disabled_reason', 'disabled_at'], take: 1 },
      );
      if (
        !state?.disabled_reason?.startsWith(PERMANENT_BAN_REASON_PREFIX) ||
        !state.disabled_at
      ) {
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
      const given = str(args.reason).slice(0, 400);
      const reason =
        given && squash(ctx.userText ?? '').includes(squash(given))
          ? given
          : 'Unbanned on request in the admin assistant';
      proposeOrRefuse(
        ctx,
        {
          kind: 'unban',
          customer_id: customerId,
          username,
          reason,
          banned_at: new Date(state.disabled_at).toISOString(),
        },
        `Unban ${shown}${handle && handle !== shown ? ` (@${handle})` : ''}: they can log in again. Their saved bank accounts are cleared, so they link a bank again themselves; a banned bank number stays banned unless you also unban it for them. Reason: ${reason}`,
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
      "Unban a banned bank number for ONE player (farm-ring numbers were banned 2026-11-03) when staff ask to unban a bank number or bank account for someone: that player may then save it and be paid to it, and it stays banned for every other account. Staff must name, in one message, the player it is for (shown name or profile handle) and the number's last 4 digits; pass the bank only when two banned numbers end the same. For an admin the player can be the one whose save was refused (the number need not be on their account); for anyone else the number must be on that player's banks or payouts. Nothing changes until the person taps the button under your answer. If another account was paid to the number, the player's own save is still refused as shared: support then adds it on the admin player page. ban_reason shows a player's banned numbers.",
    parameters: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description:
            "The player the number is unbanned for: shown name or profile handle, exactly as staff wrote it.",
        },
        last4: {
          type: 'string',
          description: 'The last 4 digits of the bank number, as staff wrote them.',
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
        throw new Error(`last4 must be the last 4 digits of the bank number. ${resend}`);
      }
      // Only what the person named in this very message, each as its own word,
      // so data the model read (a customer field, a past chat) cannot start one,
      // and digits inside a name or a phone number do not count.
      const text = ctx.userText ?? '';
      const words = text.toLowerCase().split(/[^a-z0-9_-]+/);
      if (!words.includes(username.toLowerCase()) || !words.includes(last4)) {
        throw new Error(
          `Unban a bank number only when the person names, in this message, the player it is for and its last 4 digits. ${resend}`,
        );
      }
      const packs = ctx.container.resolve<PacksModuleService>(PACKS_MODULE);
      const byName = await packs.findCustomerIdByUsername(username);
      const byHandle = await packs.findCustomerIdByHandle(username);
      if (byName && byHandle && byName !== byHandle) {
        throw new Error(
          `${username} is a shown name and a different player's handle. Ask staff for the name shown on the profile. ${resend}`,
        );
      }
      const customerId = byName ?? byHandle;
      if (!customerId) {
        throw new Error(`No player named ${username}. ${resend}`);
      }
      // The bank only breaks a tie: a name the model or staff spelled loosely
      // must not refuse a number its last 4 already names.
      const bankArg = str(args.bank).toLowerCase().replace(/\s+/g, '');
      const bank = bankArg
        ? (findBank(bankArg)?.id ??
          [...MY_BANKS, ...SG_BANKS].find((b) =>
            b.name.toLowerCase().replace(/\s+/g, '').includes(bankArg),
          )?.id ??
          null)
        : null;
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
      const bankName = findBank(hit.bank_code)?.name ?? (hit.bank_code || 'the bank');
      const given = str(args.reason).slice(0, 400);
      const reason =
        given && squash(text).includes(squash(given))
          ? given
          : 'Bank number unbanned on request in the admin assistant';
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
        `Unban ${bankName} …${last4} for ${shown}${handle && handle !== shown ? ` (@${handle})` : ''} only: they may save it and be paid to it; it stays banned for every other account. If another account was paid to it, support still adds it for them on the admin player page. Reason: ${reason}`,
      );
      return JSON.stringify({
        unbanned: false,
        waiting:
          'Nothing has changed yet: a button is under your answer, and the number is unbanned for this player only when the person taps it. Tell them so in one short line, and that if another account was paid to it, support adds it for the player on the admin player page.',
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
