import type { StoredMessage } from '../../lib/assistant';
import type { Step } from './ToolSteps';

// The chat's message shape and how stored messages become it (kept apart from
// Thread.tsx so that file exports components only, for fast refresh).
export type UiMessage = {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  /** Screenshots sent with a question: data URLs this session, a count after. */
  attachments: string[] | number;
  images: string[];
  steps: Step[];
  error?: string | null;
  pending?: boolean;
};

// Tools that draw: while one runs, a scanning placeholder holds its place.
export const DRAWS = /(_poster|^generate_image|^brand_logo)$/;

export const fromStored = (
  messages: StoredMessage[],
  labelOf: (name: string) => string,
): UiMessage[] =>
  messages.map((m) => ({
    key: m.id,
    role: m.role,
    content: m.content,
    attachments: m.attachments,
    images: m.images.map((i) => i.url),
    steps: m.tools.map((tool, i) => ({
      id: `${m.id}-${i}`,
      name: tool.name,
      label: labelOf(tool.name),
      status: tool.ok ? 'done' : 'error',
      ms: tool.ms,
    })),
    error: m.error === 'aborted' ? null : m.error,
  }));
