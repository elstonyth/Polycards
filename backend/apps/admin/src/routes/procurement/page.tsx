import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Table, Text } from '@medusajs/ui';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useProcurementToBuy, useProcurementToShip } from '../../lib/queries';
import { inCurrency, mytDateTime, orderDateTime, rm } from '../../lib/format';
import { resolveImageUrl } from '../../lib/image-url';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// The two daily lists (spec 2026-10-28 §5): cards to buy (purchasing) and
// parcels to post (mailing). Read-only — both routes already sort oldest
// waiting order first, so the page renders them in the order received.
export const config: RouteConfig = {
  label: 'pcNav.procurement',
  translationNs: 'translation',
  rank: 4,
  nested: '/inventory/list',
};

const ProcurementPage = () => {
  const { t } = useTranslation();
  const toBuy = useProcurementToBuy();
  const toShip = useProcurementToShip();

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('procurement.title')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('procurement.subtitle')}
          </Text>
        </div>
      </Container>

      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('procurement.toBuy')}</Heading>
          {toBuy.data && (
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {toBuy.data.taken_at
                ? t('procurement.frozenAt', {
                    time: mytDateTime(toBuy.data.taken_at),
                  })
                : t('procurement.live')}
            </Text>
          )}
        </div>
        {toBuy.isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {t('procurement.loadError')}
            </Text>
          </div>
        ) : !toBuy.data ? (
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : toBuy.data.rows.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {t('procurement.toBuyEmpty')}
            </Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label={t('procurement.toBuy')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>
                    {t('procurement.col.photo')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('procurement.col.card')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>{t('inventory.sku')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('procurement.col.need')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('inventory.onHand')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('procurement.col.pricecharting')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('procurement.col.oldestOrder')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {toBuy.data.rows.map((r) => {
                  // '' when resolveImageUrl refuses the URL: no <img> then,
                  // or the browser requests this page as the image.
                  const src = r.image ? resolveImageUrl(r.image) : '';
                  return (
                    <Table.Row key={r.handle}>
                      {/* Owner 2026-10-29: big enough to read in a screenshot
                        sent to the buyers' group chat. Graded = the baked
                        slab, raw = the bare card, no tier frame either way.
                        `r.image &&`: an empty string resolves to the page URL
                        and gets refetched as an image. Not lazy: a full-page
                        capture must not catch rows still empty. py-2 keeps a
                        gap between neighbouring cards in the shot. */}
                      <Table.Cell className="py-2">
                        {src && (
                          <img
                            src={src}
                            alt=""
                            decoding="async"
                            className="h-24 w-[68px] object-contain"
                          />
                        )}
                      </Table.Cell>
                      <Table.Cell className="break-words">
                        <Link
                          to={`/inventory/list/${r.handle}`}
                          className="text-ui-fg-interactive hover:underline"
                        >
                          {r.name}
                        </Link>
                        <span className="text-ui-fg-muted ml-2 text-xs">
                          {r.graded
                            ? t('inventory.graded')
                            : t('inventory.raw')}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle break-words">
                        {r.sku}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-error text-right font-semibold tabular-nums">
                        {r.to_procure}
                      </Table.Cell>
                      <Table.Cell
                        className={`text-right tabular-nums ${r.on_hand < 0 ? 'text-ui-fg-error' : ''}`}
                      >
                        {r.on_hand}
                      </Table.Cell>
                      {/* PriceCharting's own number, then RM at the live rate —
                        no 20% listing markup on this page. */}
                      <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                        {/* `== null`: undefined too, from an API pod still on
                          the old code during a rolling deploy. */}
                        {r.fmv_usd == null ? '—' : inCurrency(r.fmv_usd, 'USD')}
                        <span className="text-ui-fg-subtle block text-xs">
                          {rm(r.fmv)}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                        {r.oldest_order_at
                          ? orderDateTime(r.oldest_order_at)
                          : '—'}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        )}
      </Container>

      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('procurement.toShip')}</Heading>
        </div>
        {toShip.isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {t('procurement.loadError')}
            </Text>
          </div>
        ) : !toShip.data ? (
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : toShip.data.orders.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {t('procurement.toShipEmpty')}
            </Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label={t('procurement.toShip')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>
                    {t('procurement.col.orderDate')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('procurement.col.customer')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('procurement.col.shipTo')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('procurement.col.cards')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {toShip.data.orders.map((o) => (
                  <Table.Row key={o.id}>
                    <Table.Cell className="whitespace-nowrap">
                      {orderDateTime(o.created_at)}
                    </Table.Cell>
                    <Table.Cell className="break-all">
                      {o.customer_email ?? o.customer_id}
                    </Table.Cell>
                    <Table.Cell className="break-words">
                      {o.address.name}
                      <span className="text-ui-fg-subtle block text-xs">
                        {o.address.city} {o.address.postal_code}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="break-words">
                      {/* card is null when the pull's card row is gone —
                          the pull id still tells the packer what to find. */}
                      {o.items.map((i) => (
                        <span key={i.pull_id} className="block text-sm">
                          {i.card?.name ?? i.pull_id}
                        </span>
                      ))}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </Container>
    </div>
  );
};

export default ProcurementPage;
