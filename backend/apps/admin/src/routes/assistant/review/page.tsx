import { useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Container,
  Drawer,
  Heading,
  Table,
  Text,
} from '@medusajs/ui';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import { assistantApi } from '../../../lib/assistant';
import { mytDateTime } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Thread } from '../../../components/assistant/Thread';
import { fromStored } from '../../../components/assistant/thread-data';

// Every question every staff member asked the assistant (owner, 2026-10-29:
// "review all the questions users ask"), newest first, with who asked, how
// many turns failed and what it cost. Super admins only (assistant_review).
export const config: RouteConfig = {
  label: 'pcNav.assistantReview',
  translationNs: 'translation',
  rank: 10,
  nested: '/assistant',
  permissions: ['assistant_review:read' as Permission],
};

const PAGE = 50;

const ReviewPage = () => {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['assistant', 'review', offset],
    queryFn: () => assistantApi.review(offset),
    placeholderData: keepPreviousData,
  });
  const thread = useQuery({
    queryKey: ['assistant', 'review-thread', open],
    queryFn: () => assistantApi.reviewThread(open as string),
    enabled: !!open,
  });
  // The list never shrinks (deleted chats stay in the review), so a page
  // can't fall past the end.
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
        {!list.data ? (
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : list.data.conversations.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {t('assistant.review.empty')}
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
                    {t('assistant.review.who')}
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
                    <Table.Cell className="break-all">
                      {c.user_email ?? c.user_id}
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
                      USD {c.cost_usd.toFixed(3)}
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
            {thread.data ? (
              <Thread
                messages={fromStored(thread.data.messages, (name) =>
                  t(`assistant.tools.${name}`, { defaultValue: name }),
                )}
              />
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
