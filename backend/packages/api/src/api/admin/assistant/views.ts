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
  content: m.content,
  attachments: m.attachments,
  images: m.images ?? [],
  tools: m.tools ?? [],
  error: m.error,
  cost_usd: Number(m.cost_usd ?? 0),
  created_at: m.created_at,
});
