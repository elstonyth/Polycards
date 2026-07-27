import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge, Container, StatusBadge, Table, Text } from '@medusajs/ui';
import type { PullRow } from '../lib/packs-api';
import { resolveImageUrl } from '../lib/image-url';
import { rm, timeAgo } from '../lib/format';
import { Pager } from './Pager';
import { LoadingSkeleton } from './LoadingSkeleton';

// The pull-ledger table, lifted out of the retired standalone page (spec D6)
// so the player-detail Pulls and Orders tabs render the ledger the operator
// already knows. `pulls: null` = not loaded yet.
//
// No heading of its own: the caller owns it. "Recent pulls" is right above the
// site-wide ledger and wrong above a player's Pack purchases.
//
// showCustomer=false drops the customer column — a player-scoped table would
// repeat the same email on every row.
export const PullsTable = ({
  pulls,
  page,
  onPage,
  limit,
  total,
  showCustomer = true,
}: {
  pulls: PullRow[] | null;
  page: number;
  onPage: (p: number) => void;
  limit: number;
  total: number;
  showCustomer?: boolean;
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Container className="p-0">
      {pulls === null ? (
        <div className="px-6 py-8">
          <LoadingSkeleton />
        </div>
      ) : pulls.length === 0 ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">{t('pulls.empty')}</Text>
        </div>
      ) : (
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Pulls table"
        >
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t('pulls.card')}</Table.HeaderCell>
                <Table.HeaderCell>{t('pulls.rarity')}</Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t('pulls.value')}
                </Table.HeaderCell>
                {showCustomer && (
                  <Table.HeaderCell>{t('pulls.customer')}</Table.HeaderCell>
                )}
                <Table.HeaderCell>{t('pulls.pack')}</Table.HeaderCell>
                <Table.HeaderCell>{t('pulls.status')}</Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t('pulls.when')}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {pulls.map((p) => (
                <Table.Row key={p.id}>
                  <Table.Cell>
                    <div className="flex items-center gap-3">
                      {/* `?.image` and not just `p.card`: a card row with an
                          empty image would render <img src=""> — which the
                          browser resolves to the page URL and refetches. */}
                      {p.card?.image && (
                        <img
                          src={resolveImageUrl(p.card.image)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-10 w-8 shrink-0 rounded object-contain"
                        />
                      )}
                      <span className="max-w-[20rem] truncate">
                        {p.card?.name ?? p.card?.handle ?? '—'}
                      </span>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    {p.card?.rarity ? (
                      <Badge size="2xsmall">{p.card.rarity}</Badge>
                    ) : (
                      '—'
                    )}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle text-right tabular-nums whitespace-nowrap">
                    {rm(p.card?.market_value ?? null)}
                  </Table.Cell>
                  {showCustomer && (
                    <Table.Cell className="text-ui-fg-subtle">
                      {p.customer_id ? (
                        <button
                          type="button"
                          className="text-ui-fg-interactive hover:underline"
                          onClick={() => navigate(`/customers/${p.customer_id}`)}
                        >
                          {p.customer_email ?? p.customer_id.slice(0, 8)}
                        </button>
                      ) : (
                        t('pulls.anon')
                      )}
                    </Table.Cell>
                  )}
                  <Table.Cell className="text-ui-fg-subtle break-words">
                    {p.pack_title ?? p.pack_id}
                  </Table.Cell>
                  <Table.Cell>
                    {p.status === 'bought_back' ? (
                      <StatusBadge color="orange">
                        {t('pulls.boughtBack', { amount: rm(p.buyback_amount) })}
                      </StatusBadge>
                    ) : (
                      <StatusBadge color="green">
                        {t('pulls.vaulted')}
                      </StatusBadge>
                    )}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle text-right">
                    {timeAgo(p.rolled_at)}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      {pulls !== null && (
        <Pager
          page={page}
          onPage={onPage}
          pageSize={limit}
          count={pulls.length}
          total={total}
        />
      )}
    </Container>
  );
};
