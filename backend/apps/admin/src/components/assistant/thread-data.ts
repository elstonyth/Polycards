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
  /** The saved answer's id: what "read aloud" asks for. */
  messageId?: string;
  /** A question as asked (a spoken one's transcript): what Try again and
   *  ArrowUp reuse. Unset while a spoken question is not heard yet. */
  question?: string;
  /** An answer stopped by the person before it finished. */
  stopped?: boolean;
  /** When the question went out: the thinking counter counts from it. */
  since?: number;
  /** Notes or tasks the AI proposed, kept only once tapped. This session
   *  only: a reload drops them. */
  proposals?: Proposal[];
};

export type Proposal = {
  token: string;
  kind: 'note' | 'schedule';
  summary: string;
  state: 'waiting' | 'saving' | 'saved';
};

// Tools that draw: while one runs, a scanning placeholder holds its place.
export const DRAWS = /(_poster|^generate_image|^brand_logo)$/;

// Steps keep only the tool's name; ToolSteps puts it in the page's language.
export const fromStored = (messages: StoredMessage[]): UiMessage[] =>
  messages.map((m) => ({
    key: m.id,
    role: m.role,
    content: m.content,
    attachments: m.attachments,
    images: m.images.map((i) => i.url),
    steps: m.tools.map((tool, i) => ({
      id: `${m.id}-${i}`,
      name: tool.name,
      status: tool.ok ? 'done' : 'error',
      ms: tool.ms,
    })),
    error: m.error === 'aborted' ? null : m.error,
    stopped: m.error === 'aborted',
    messageId: m.role === 'assistant' ? m.id : undefined,
    question: m.role === 'user' ? m.content : undefined,
  }));
