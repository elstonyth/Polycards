import { MedusaService } from '@medusajs/framework/utils';
import AssistantConversation from './models/assistant-conversation';
import AssistantMemory from './models/assistant-memory';
import AssistantMessage from './models/assistant-message';
import AssistantSchedule from './models/assistant-schedule';
import AssistantSettings from './models/assistant-settings';

export type AssistantSettingsRow = {
  id: string;
  openrouter_key_sealed: string | null;
  openrouter_key_last4: string | null;
  chat_model: string;
  image_model: string;
  daily_cap_usd: number;
  image_style: string | null;
  style_refs: unknown;
  stt_model: string;
  voice_model: string;
  voice: string;
  updated_by: string | null;
  updated_at: Date | string;
};

const MYT_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 00:00 Malaysia time (UTC+8, no DST) of the day containing `now`. */
export const mytDayStart = (now: Date): Date =>
  new Date(Math.floor((now.getTime() + MYT_MS) / DAY_MS) * DAY_MS - MYT_MS);

class AssistantModuleService extends MedusaService({
  AssistantSettings,
  AssistantConversation,
  AssistantMessage,
  AssistantMemory,
  AssistantSchedule,
}) {
  /** The singleton settings row, created with the defaults on first read. */
  async settings(): Promise<AssistantSettingsRow> {
    const [row] = await this.listAssistantSettings(
      {},
      { take: 1, order: { created_at: 'ASC' } },
    );
    return (row ??
      (await this.createAssistantSettings(
        {},
      ))) as unknown as AssistantSettingsRow;
  }

  /** What one admin user's assistant answers cost today (Malaysia day), USD,
   *  answers read aloud included. Deleted chats count too: deleting one must
   *  not reset the cap. */
  async spentToday(userId: string, now: Date = new Date()): Promise<number> {
    const since = mytDayStart(now);
    // A chat is bumped when an answer starts; one started before midnight
    // and saved after must still count today, so chats bumped up to 30
    // minutes earlier are looked at too (an answer runs at most 4).
    const convs = await this.listAssistantConversations(
      {
        user_id: userId,
        last_message_at: { $gte: new Date(since.getTime() - 30 * 60_000) },
      },
      { select: ['id'], withDeleted: true },
    );
    if (!convs.length) return 0;
    const msgs = await this.listAssistantMessages(
      {
        conversation_id: convs.map((c) => c.id),
        role: ['assistant', 'voice'],
        created_at: { $gte: since },
      },
      { select: ['cost_usd'], withDeleted: true },
    );
    return msgs.reduce((sum, m) => sum + Number(m.cost_usd ?? 0), 0);
  }
}

export default AssistantModuleService;
