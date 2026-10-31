import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Container, StatusBadge, Table } from '@medusajs/ui';
import { useCustomerPulls } from '../../../lib/queries';
import type { SupportPull } from '../../../lib/admin-rest';
import { rm } from '../../../lib/format';
import { resolveImageUrl } from '../../../lib/image-url';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';
import {
  CardLine,
  DetailDrawer,
  DetailRow,
  DetailRows,
  FilterPills,
  TableState,
  When,
  openableRow,
  whenText,
} from './bits';

// Exhaustive over the pull lifecycle, so a shipped card can never read as "in
// vault" again. Sold back is orange as it always was: the card has left.
const STATUS_TONE: Record<
  SupportPull['status'],
  'green' | 'orange' | 'blue' | 'grey'
> = {
  vaulted: 'green',
  bought_back: 'orange',
  delivering: 'blue',
  delivered: 'grey',
};

const STATUS_FILTERS = [
  'all',
  'vaulted',
  'bought_back',
  'delivering',
  'delivered',
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export const PullStatusBadge = ({ pull }: { pull: SupportPull }) => {
  const { t } = useTranslation();
  return (
    <StatusBadge color={STATUS_TONE[pull.status] ?? 'grey'}>
      {pull.status === 'bought_back'
        ? t('pulls.boughtBack', { amount: rm(pull.buyback_amount) })
        : t(`playerDetail.pullStatus.${pull.status}`, pull.status)}
    </StatusBadge>
  );
};

/** The pack's title, or how they got the card when no pack row exists (a task
 *  reward has a slug, not a pack). */
export const useOrigin = () => {
  const { t } = useTranslation();
  return (p: SupportPull) =>
    p.pack_title ??
    (p.source ? t(`playerDetail.source.${p.source}`, p.source) : p.pack_id);
};

export const PullDrawer = ({
  pull,
  onClose,
}: {
  pull: SupportPull;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const origin = useOrigin();
  const q = pull.quote;
  return (
    <DetailDrawer
      title={pull.card?.name ?? t('playerDetail.pullTitle')}
      onClose={onClose}
    >
      <div className="px-6 py-4">
        <CardLine
          name={pull.card?.name ?? '—'}
          image={pull.card?.image}
          note={pull.card?.handle}
        />
      </div>
      <DetailRows>
        <DetailRow
          label={t('pulls.status')}
          value={<PullStatusBadge pull={pull} />}
        />
        <DetailRow label={t('pulls.pack')} value={origin(pull)} />
        <DetailRow label={t('pulls.rarity')} value={pull.card?.rarity} />
        <DetailRow
          label={t('playerMoney.colFmv')}
          value={pull.card ? rm(pull.card.market_value) : null}
        />
        <DetailRow
          label={t('players.pulledAt')}
          value={whenText(pull.rolled_at)}
        />
        <DetailRow
          label={t('playerDetail.soldAt')}
          value={whenText(pull.buyback_at)}
        />
        <DetailRow
          label={t('playerMoney.colSellNow')}
          value={
            q
              ? `${rm(q.amount)} · ${q.percent}%${q.firm ? '' : ` · ${t('playerDetail.sellPaused')}`}`
              : null
          }
        />
        <DetailRow label={t('players.order')} code={pull.order_id} />
        <DetailRow label={t('playerDetail.pullId')} code={pull.id} />
      </DetailRows>
    </DetailDrawer>
  );
};

/**
 * This player's pulls: every source with a status filter (the Pulls tab), or
 * paid packs only (the Orders tab's Pack purchases).
 */
export const PullsList = ({
  customerId,
  source,
}: {
  customerId: string;
  source?: 'pack';
}) => {
  const { t } = useTranslation();
  const origin = useOrigin();
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [open, setOpen] = useState<SupportPull | null>(null);
  const { data, isError } = useCustomerPulls(customerId, page, {
    status: status === 'all' ? undefined : status,
    source,
  });
  const rows = data?.items ?? [];

  return (
    <>
      {!source && (
        <div className="px-6 py-4">
          <FilterPills
            label={t('pulls.status')}
            value={status}
            options={STATUS_FILTERS.map((s) => ({
              value: s,
              label:
                s === 'all'
                  ? t('playerMoney.filter.all')
                  : t(`playerDetail.pullFilter.${s}`),
            }))}
            onChange={(s) => {
              setStatus(s);
              setPage(0);
            }}
          />
        </div>
      )}
      {isError ? (
        <TableState isError />
      ) : !data ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
        </div>
      ) : rows.length === 0 ? (
        <TableState empty={t('pulls.empty')} />
      ) : (
        <>
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label={t('players.tabPulls')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('pulls.card')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('pulls.rarity')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('pulls.value')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>{t('pulls.pack')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('pulls.status')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('pulls.when')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((p) => (
                  <Table.Row key={p.id} {...openableRow(() => setOpen(p))}>
                    <Table.Cell>
                      <div className="flex items-center gap-3 py-1">
                        {/* `?.image`: an empty image would render <img src="">,
                            which the browser resolves to the page URL. */}
                        {p.card?.image ? (
                          <img
                            src={resolveImageUrl(p.card.image)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="h-10 w-8 shrink-0 rounded object-contain"
                          />
                        ) : (
                          <span className="bg-ui-bg-component h-10 w-8 shrink-0 rounded" />
                        )}
                        <span className="max-w-[20rem] truncate">
                          {p.card?.name ?? '—'}
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
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-right tabular-nums">
                      {rm(p.card?.market_value ?? null)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      {origin(p)}
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      <PullStatusBadge pull={p} />
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
    </>
  );
};

// The relocated Pull Ledger (spec D6): every pull this player has made, all
// sources, buyback states included.
export const PullsTab = ({ customerId }: { customerId: string }) => (
  <Container className="p-0">
    <PullsList customerId={customerId} />
  </Container>
);
