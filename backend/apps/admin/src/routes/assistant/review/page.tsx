import { useEffect, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Container,
  Drawer,
  Heading,
  Input,
  Table,
  Text,
  Tooltip,
} from '@medusajs/ui';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import { assistantApi, type ReviewRow } from '../../../lib/assistant';
import { mytDateTime } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { SpeakerIcon } from '../../../components/assistant/VoiceIcons';
import { Thread } from '../../../components/assistant/Thread';
import { fromStored } from '../../../components/assistant/thread-data';

// The signed-in account's own chats with the assistant, deleted ones too,
// newest first, with how many turns failed and what each cost. Each account
// sees only its own conversations (2026-10-29). Super admins only
// (assistant_review).
export const config: RouteConfig = {
  label: 'pcNav.assistantReview',
  translationNs: 'translation',
  rank: 10,
  nested: '/assistant',
  permissions: ['assistant_review:read' as Permission],
};

// A role without the review (a typed URL) goes to its own chat, not a 403.
export const handle = {
  permissions: 'assistant_review:read',
  redirectTo: '/assistant',
};

declare const __BACKEND_URL__: string;

const PAGE = 50;

type Row = ReviewRow & { read_aloud: number; voice_cost_usd: number };

// Like lib/assistant's call(), plus the search.
async function fetchReview(offset: number, q: string) {
  const qs = new URLSearchParams({
    limit: String(PAGE),
    offset: String(offset),
  });
  if (q) qs.set('q', q);
  const res = await fetch(`${__BACKEND_URL__}/admin/assistant-review?${qs}`, {
    credentials: 'include',
  });
  const data = (await res.json().catch(() => null)) as {
    count: number;
    conversations: Row[];
    message?: string;
  } | null;
  if (!res.ok) {
    throw new Error(data?.message ?? `Request failed (${res.status}).`);
  }
  return data as { count: number; conversations: Row[] };
}

const ReviewPage = () => {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);
  const list = useQuery({
    queryKey: ['assistant', 'review', offset, q],
    queryFn: () => fetchReview(offset, q),
    placeholderData: keepPreviousData,
  });
  const thread = useQuery({
    queryKey: ['assistant', 'review-thread', open],
    queryFn: () => assistantApi.reviewThread(open as string),
    enabled: !!open,
  });
  // The list never shrinks (deleted chats stay in the review) and a new
  // filter starts on page one, so a page can't fall past the end.
  const count = list.data?.count ?? 0;

  return (
    <MotionConfig reducedMotion="user">
      <div className="pc-admin flex flex-col gap-y-3">
        <Container className="p-0">
          <div className="px-6 py-4">
            <Heading level="h2">{t('assistant.review.title')}</Heading>
            <Text size="small" className="text-ui-fg-subtle mt-1">
              {t('assistant.review.subtitle')}
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t px-6 py-3">
            <Input
              type="search"
              size="small"
              className="w-72"
              placeholder={t('assistant.review.search', {
                defaultValue: 'Search titles and messages',
              })}
              aria-label={t('assistant.review.search', {
                defaultValue: 'Search titles and messages',
              })}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </div>
          {list.isError ? (
            <div className="border-t px-6 py-8">
              <Text className="text-ui-fg-subtle">
                {t('assistant.loadError', { message: list.error.message })}
              </Text>
            </div>
          ) : !list.data ? (
            <div className="border-t px-6 py-8">
              <LoadingSkeleton />
            </div>
          ) : list.data.conversations.length === 0 ? (
            <div className="border-t px-6 py-8">
              <Text className="text-ui-fg-subtle">
                {q
                  ? t('assistant.review.noMatches', {
                      defaultValue: 'No chats match.',
                    })
                  : t('assistant.review.empty')}
              </Text>
            </div>
          ) : (
            <div className="overflow-x-auto border-t">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>
                      {t('assistant.review.when')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('assistant.review.question')}
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t('assistant.review.turns')}
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t('assistant.review.failed')}
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t('assistant.review.cost')}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {list.data.conversations.map((c) => (
                    <Table.Row
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => setOpen(c.id)}
                    >
                      <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                        {mytDateTime(c.last_message_at)}
                      </Table.Cell>
                      <Table.Cell className="max-w-[420px]">
                        {/* A real button, so the row opens from the keyboard too. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(c.id);
                          }}
                          className="text-ui-fg-base hover:text-ui-fg-interactive flex max-w-full items-center gap-x-2 text-left"
                        >
                          <span className="truncate">{c.title}</span>
                          {c.read_aloud > 0 && (
                            <Badge
                              size="2xsmall"
                              color="blue"
                              role="img"
                              aria-label={t('assistant.review.readAloud', {
                                count: c.read_aloud,
                                defaultValue: 'Read aloud: {{count}}',
                              })}
                              className="shrink-0 gap-x-0.5"
                            >
                              <SpeakerIcon className="size-3" />
                              {c.read_aloud}
                            </Badge>
                          )}
                          {c.deleted && (
                            <Badge size="2xsmall" color="grey">
                              {t('assistant.review.deleted')}
                            </Badge>
                          )}
                        </button>
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums">
                        {c.questions}
                      </Table.Cell>
                      <Table.Cell
                        className={`text-right tabular-nums ${c.failed ? 'text-ui-fg-error' : 'text-ui-fg-muted'}`}
                      >
                        {c.failed}
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums">
                        {c.voice_cost_usd > 0 ? (
                          <Tooltip
                            content={t('assistant.review.voiceCost', {
                              cost: c.voice_cost_usd.toFixed(3),
                              defaultValue: 'Voice: USD {{cost}} of this',
                            })}
                          >
                            <span tabIndex={0} className="cursor-help">
                              USD {c.cost_usd.toFixed(3)}
                            </span>
                          </Tooltip>
                        ) : (
                          <>USD {c.cost_usd.toFixed(3)}</>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
          {count > PAGE && (
            <div className="flex items-center justify-end gap-x-2 border-t px-6 py-3">
              <Text size="small" className="text-ui-fg-subtle">
                {offset + 1}–{Math.min(offset + PAGE, count)} / {count}
              </Text>
              <Button
                size="small"
                variant="secondary"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
              >
                ‹
              </Button>
              <Button
                size="small"
                variant="secondary"
                disabled={offset + PAGE >= count}
                onClick={() => setOffset((o) => o + PAGE)}
              >
                ›
              </Button>
            </div>
          )}
        </Container>

        <Drawer open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
          <Drawer.Content className="pc-admin max-w-2xl">
            <Drawer.Header>
              <Drawer.Title>
                {thread.data?.conversation.title ?? '…'}
              </Drawer.Title>
            </Drawer.Header>
            <Drawer.Body className="overflow-y-auto">
              {thread.isError ? (
                <Text className="text-ui-fg-subtle">
                  {t('assistant.loadError', { message: thread.error.message })}
                </Text>
              ) : thread.data ? (
                <>
                  {thread.data.truncated && (
                    <Text size="small" className="text-ui-fg-muted px-6 pt-4">
                      {t('assistant.review.truncated')}
                    </Text>
                  )}
                  <Thread messages={fromStored(thread.data.messages)} />
                </>
              ) : (
                <LoadingSkeleton />
              )}
            </Drawer.Body>
          </Drawer.Content>
        </Drawer>
      </div>
    </MotionConfig>
  );
};

export default ReviewPage;
