import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Container,
  Heading,
  StatusBadge,
  Table,
  Text,
} from '@medusajs/ui';
import {
  useCustomerGacha,
  useCustomerMoney,
  useCustomerPackGifts,
  useCustomerPulls,
} from '../../../lib/queries';
import type { SupportPull } from '../../../lib/admin-rest';
import { rm } from '../../../lib/format';
import { resolveImageUrl } from '../../../lib/image-url';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';
import { StatTile } from './MoneyCards';
import { PullDrawer } from './PullsTab';
import { FilterPills, TableState, When } from './bits';
import { openableRow } from './row-helpers';

type Sort = 'newest' | 'value';
const SORTS: Sort[] = ['newest', 'value'];
type Held = 'vaulted' | 'delivering';

/**
 * The cards a player still holds: how many, what they'd get selling them
 * all back now, and what the storefront shows them as worth; then each
 * held card with its value and its payable-now sell price, newest or most
 * valuable first. Cards on their way to the player sit under their own filter,
 * because they are still owed and the tiles above count them.
 */
export const VaultTab = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<Sort>('newest');
  const [held, setHeld] = useState<Held>('vaulted');
  const [open, setOpen] = useState<SupportPull | null>(null);
  const { data: view } = useCustomerGacha(customerId);
  const { data: money } = useCustomerMoney(customerId);
  // status is applied server-side AND keyed, so this never shows a bought-back
  // card and never collides with the Pulls tab's full history.
  const { data, isError } = useCustomerPulls(customerId, page, {
    status: held,
    sort,
  });
  // Same key as the Gifts and bonus tab, so a send or revoke there refreshes
  // this list too.
  const { data: gifts, isError: giftsFailed } =
    useCustomerPackGifts(customerId);
  // Still in the player's vault as a pack: not opened yet, or a claim that
  // never produced a card (stuck — revoke it from Gifts and bonus).
  const unopenedGifts = (gifts ?? []).filter(
    (g) => g.state === 'unopened' || g.state === 'stuck',
  );
  const giftPulls = new Set((gifts ?? []).map((g) => g.pull_id));
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
          note={
            shipping > 0
              ? t('playerDetail.sellbackInclShipping', { count: shipping })
              : t('playerMoney.sellbackNote')
          }
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

      {/* A failed read must not look like "no gifts held". */}
      {giftsFailed && !gifts && (
        <div className="border-t px-6 py-4">
          <Text size="small" className="text-ui-fg-error">
            {t('customer360.gift.loadError')}
          </Text>
        </div>
      )}
      {unopenedGifts.length > 0 && (
        <>
          <div className="border-t px-6 py-4">
            <Heading level="h2">
              {t('playerMoney.giftPacksTitle')} ({unopenedGifts.length})
            </Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t('playerMoney.giftPacksNote')}
            </Text>
          </div>
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label={t('playerMoney.giftPacksTitle')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>
                    {t('customer360.gift.colPack')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.gift.colState')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('playerMoney.colValue')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.gift.colGranted')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.gift.colNote')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {unopenedGifts.map((g) => (
                  <Table.Row key={g.id}>
                    <Table.Cell>{g.pack_title}</Table.Cell>
                    <Table.Cell>
                      <StatusBadge color={g.state === 'stuck' ? 'red' : 'blue'}>
                        {t(`customer360.gift.state.${g.state}`, g.state)}
                      </StatusBadge>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-right tabular-nums">
                      {rm(g.value_myr)}
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      <When iso={g.created_at} />
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle max-w-[20rem] truncate">
                      {g.note}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
        <FilterPills
          label={t('playerMoney.vaultTitle')}
          value={held}
          options={[
            {
              value: 'vaulted',
              label: `${t('playerDetail.pullFilter.vaulted')} (${view?.vault.count ?? '…'})`,
            },
            {
              value: 'delivering',
              label: `${t('playerDetail.pullFilter.delivering')} (${shipping})`,
            },
          ]}
          onChange={(h) => {
            setHeld(h);
            setPage(0);
          }}
        />
        <FilterPills
          label={t('playerDetail.sortBy')}
          value={sort}
          options={SORTS.map((s) => ({
            value: s,
            label: t(`playerMoney.sort.${s}`),
          }))}
          onChange={(s) => {
            setSort(s);
            setPage(0);
          }}
        />
      </div>

      {isError ? (
        <TableState isError />
      ) : !data ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
        </div>
      ) : rows.length === 0 ? (
        <TableState
          empty={
            held === 'delivering'
              ? t('playerDetail.noneShipping')
              : shipping > 0
                ? t('playerDetail.vaultEmptyShipping', { count: shipping })
                : t('playerDetail.vaultEmpty')
          }
        />
      ) : (
        <>
          {sellsPaused && held === 'vaulted' && (
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
                    {held === 'delivering'
                      ? t('players.order')
                      : t('playerMoney.colSellNow')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>{t('players.pulledAt')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((p) => (
                  <Table.Row key={p.id} {...openableRow(() => setOpen(p))}>
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
                          {(p.pack_title || giftPulls.has(p.id)) && (
                            <div className="text-ui-fg-subtle txt-compact-xsmall flex items-center gap-1.5 truncate">
                              {p.pack_title}
                              {giftPulls.has(p.id) && (
                                <Badge size="2xsmall" color="blue">
                                  {t('playerMoney.fromGift')}
                                </Badge>
                              )}
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
                      {held === 'delivering' ? (
                        <span className="font-mono text-xs">
                          {p.order_id ? `#${p.order_id.slice(-6)}` : '—'}
                        </span>
                      ) : p.quote ? (
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
                      <When iso={p.rolled_at} />
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
      {open && <PullDrawer pull={open} onClose={() => setOpen(null)} />}
    </Container>
  );
};
