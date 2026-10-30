import { cutToolMarkup } from './openrouter';

// A stored message as the admin pages read it (own chats and the review).
export const messageView = (m: {
  id: string;
  role: string;
  content: string;
  attachments: number;
  images: unknown;
  tools: unknown;
  error: string | null;
  cost_usd: number;
  created_at: Date | string;
}) => ({
  id: m.id,
  role: m.role,
  content: cutToolMarkup(m.content),
  attachments: m.attachments,
  // the URL only: the file id is for deleting the chat
  images: Array.isArray(m.images)
    ? (m.images as { url?: unknown }[]).map((i) => ({ url: i?.url }))
    : [],
  tools: m.tools ?? [],
  error: m.error,
  cost_usd: Number(m.cost_usd ?? 0),
  created_at: m.created_at,
});
