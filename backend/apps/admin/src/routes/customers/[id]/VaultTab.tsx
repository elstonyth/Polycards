import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Container, Heading, Table, Text } from '@medusajs/ui';
import {
  useCustomerGacha,
  useCustomerMoney,
  useCustomerPulls,
} from '../../../lib/queries';
import { orderDateTime, rm, timeAgo } from '../../../lib/format';
import { resolveImageUrl } from '../../../lib/image-url';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';
import { StatTile } from './MoneyCards';

type Sort = 'newest' | 'value';
const SORTS: Sort[] = ['newest', 'value'];

/**
 * The cards a player still holds: how many, what they'd get selling them
 * all back now, and what the storefront shows them as worth; then each
 * vaulted card with its value and its payable-now sell price, newest or most
 * valuable first.
 */
export const VaultTab = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<Sort>('newest');
  const { data: view } = useCustomerGacha(customerId);
  const { data: money } = useCustomerMoney(customerId);
  // status:'vaulted' is applied server-side AND keyed, so this never shows a
  // bought-back card and never collides with the support page's full history.
  const { data, isError } = useCustomerPulls(customerId, page, {
    status: 'vaulted',
    sort,
  });
  const rows = data?.items ?? [];
  const shipping = money?.owed.cards.delivering ?? 0;
  // The FX feed is on its display fallback: every sell is refused, so the
  // prices below are indicative only (GET /admin/customers/:id/pulls).
  const sellsPaused = data?.fx?.firm === false;

  return (
    <Container className="p-0">
      <div className="bg-ui-border-base grid grid-cols-1 gap-px md:grid-cols-3">
        <StatTile
          label={t('playerMoney.vaultCount')}
          value={view ? view.vault.count : '—'}
          note={
            shipping > 0
              ? t('playerMoney.vaultShipping', { count: shipping })
              : t('playerMoney.vaultNoneShipping')
          }
        />
        <StatTile
          label={t('playerMoney.sellbackValue')}
          hint={t('playerMoney.sellbackHint')}
          value={
            money
              ? rm(
                  money.owed.cards.sellback +
                    money.owed.cards_no_topup.sellback,
                )
              : '—'
          }
          note={t('playerMoney.sellbackNote')}
        />
        <StatTile
          label={t('playerMoney.storefrontValue')}
          value={view ? rm(view.vault.display_value) : '—'}
          note={
            view
              ? t('playerMoney.fmvNote', {
                  amount: rm(view.vault.market_value),
                })
              : undefined
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
        <Heading level="h2">{t('playerMoney.vaultTitle')}</Heading>
        <div
          className="flex gap-1"
          role="group"
          aria-label={t('playerMoney.vaultTitle')}
        >
          {SORTS.map((s) => (
            <Button
              key={s}
              size="small"
              variant={sort === s ? 'primary' : 'secondary'}
              aria-pressed={sort === s}
              onClick={() => {
                setSort(s);
                setPage(0);
              }}
            >
              {t(`playerMoney.sort.${s}`)}
            </Button>
          ))}
        </div>
      </div>

      {isError ? (
        <div className="border-t px-6 py-6">
          <Text size="small" className="text-ui-fg-error">
            Failed to load.
          </Text>
        </div>
      ) : !data ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
        </div>
      ) : rows.length === 0 ? (
        <div className="border-t px-6 py-6">
          <Text className="text-ui-fg-subtle">{t('support.empty')}</Text>
        </div>
      ) : (
        <>
          {sellsPaused && (
            <div className="bg-ui-tag-orange-bg border-t px-6 py-3">
              <Text size="small" className="text-ui-tag-orange-text">
                {t('playerMoney.sellsPaused')}
              </Text>
            </div>
          )}
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label={t('playerMoney.vaultTitle')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('support.card')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('playerMoney.colFmv')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('playerMoney.colSellNow')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>{t('players.pulledAt')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((p) => (
                  <Table.Row key={p.id}>
                    <Table.Cell>
                      <div className="flex items-center gap-3 py-1">
                        {/* `?.image`, not just `p.card`: an empty image would
                            render <img src=""> — which the browser resolves to
                            the page URL and refetches. */}
                        {p.card?.image ? (
                          <img
                            src={resolveImageUrl(p.card.image)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="h-14 w-10 shrink-0 rounded object-contain"
                          />
                        ) : (
                          <span className="bg-ui-bg-component h-14 w-10 shrink-0 rounded" />
                        )}
                        <div className="min-w-0">
                          <div className="max-w-[22rem] truncate">
                            {p.card?.name ?? '—'}
                          </div>
                          {p.pack_title && (
                            <div className="text-ui-fg-subtle txt-compact-xsmall truncate">
                              {p.pack_title}
                            </div>
                          )}
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-right tabular-nums">
                      {rm(p.card?.market_value ?? null)}
                    </Table.Cell>
                    <Table.Cell className="txt-compact-small-plus whitespace-nowrap text-right tabular-nums">
                      {/* No quote: a free welcome card still locked, or a
                          card row that no longer exists. A quote off the FX
                          fallback is greyed: that sell would be refused. */}
                      {p.quote ? (
                        <span
                          className={
                            p.quote.firm ? '' : 'text-ui-fg-muted line-through'
                          }
                          title={
                            p.quote.firm
                              ? undefined
                              : t('playerMoney.sellsPaused')
                          }
                        >
                          {rm(p.quote.amount)}
                        </span>
                      ) : (
                        <span
                          className="text-ui-fg-muted"
                          title={t('playerMoney.sellLocked')}
                        >
                          —
                        </span>
                      )}
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      <div className="tabular-nums">
                        {orderDateTime(p.rolled_at)}
                      </div>
                      <div className="text-ui-fg-subtle txt-compact-xsmall">
                        {timeAgo(p.rolled_at)}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          <Pager
            page={page}
            onPage={setPage}
            pageSize={25}
            count={rows.length}
            total={data.total}
          />
        </>
      )}
    </Container>
  );
};
