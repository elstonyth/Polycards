import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Container, Heading, Table, Text } from '@medusajs/ui';
import { ArrowLeft } from '@medusajs/icons';
import { useInventoryItem } from '../../../../lib/queries';
import { httpStatus } from '../../../../lib/admin-rest';
import { orderDateTime, rm } from '../../../../lib/format';
import { resolveImageUrl } from '../../../../lib/image-url';
import { Pager } from '../../../../components/Pager';
import { LoadingSkeleton } from '../../../../components/LoadingSkeleton';

// NOT `src/routes/inventory/[handle]/page.tsx`, which is what the task brief
// asked for. Medusa core owns `/inventory` INCLUDING a `:id` child (its
// inventory-item detail screen), so a custom `:handle` is pushed as an
// equal-rank react-router sibling and loses the tie — `/inventory/inv_123` AND
// `/inventory/<card-handle>` would both reach CORE's loader and this page would
// be unreachable. Verified by running the shipped @mercurjs/admin bundle's own
// mergeRoutes/addRoute/createLeafRoute over the real route tree, the same way
// the sibling list page's placement was settled. `/inventory/list/:handle`
// nests under a segment core does not own, so it is additive.
//
// ponytail: no config export — this route is reached by a row click, so it must
// stay out of the sidebar (same convention as purchase-invoices/[id] and the
// Epic 1 print page). Do not "fix" the omission.

const InventoryItemDetailPage = () => {
  const { handle } = useParams<{ handle: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const { data, isError, error } = useInventoryItem(handle ?? null, page);

  // A 404 is the ONLY failure that means "no such item". A 500, a dropped
  // connection or an expired session reported as "not found" tells the operator
  // a catalog product was deleted. Message-matching cannot do this: an unrouted
  // Medusa 404 carries no `message` field at all, which is why httpError puts
  // the status on the Error itself.
  const notFound = httpStatus(error) === 404;

  const item = data?.item;
  const associated = data?.associated;
  const movements = data?.movements;

  // `cost` and `on_hand` are THREE-STATE and the two zeros mean different
  // things: cost 0 = bought and free, on_hand 0 = tracked with nothing
  // shippable, null = no purchase history / tracks no inventory. rm() already
  // renders null as an em dash and 0 as RM 0.00, and on_hand uses `??` — do NOT
  // reintroduce a truthiness test on either.
  const stats = item
    ? [
        { label: t('inventory.fmv'), value: rm(item.fmv) },
        { label: t('inventory.price'), value: rm(item.price) },
        {
          label: t('inventory.cost'),
          value: rm(item.cost),
          title: item.cost === null ? t('inventory.noCost') : undefined,
        },
        {
          label: t('inventory.onHand'),
          value: item.on_hand ?? '—',
          title: item.on_hand === null ? t('inventory.noStock') : undefined,
          // (null ?? 0) < 0 is false, so an untracked row is never coloured as
          // a deficit — only a genuinely oversold one is.
          tone: (item.on_hand ?? 0) < 0 ? 'text-ui-fg-error' : '',
        },
        { label: t('inventory.inVault'), value: item.in_vault },
        { label: t('inventory.requested'), value: item.requested },
      ]
    : [];

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="px-6 py-4">
          <button
            type="button"
            onClick={() => navigate('/inventory/list')}
            className="text-ui-fg-subtle hover:text-ui-fg-base mb-2 flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('inventory.detail.back')}
          </button>

          {/* Body-swap, never a top-level early return: an early return throws
              away the back link, so a failed or slow load strands the operator
              on a page with no way back to the list. */}
          {isError ? (
            <Text className="text-ui-fg-subtle">
              {notFound
                ? t('inventory.detail.notFound')
                : t('inventory.detail.loadError')}
            </Text>
          ) : !item ? (
            <LoadingSkeleton />
          ) : (
            <>
              <div className="flex items-center gap-4">
                {/* `item.photo &&`, not just a src: an empty string resolves to
                    the page URL and gets refetched as an image. */}
                {item.photo && (
                  <img
                    src={resolveImageUrl(item.photo)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-16 w-16 shrink-0 rounded object-cover"
                  />
                )}
                <div>
                  <Heading level="h2" className="break-words">
                    {item.name}
                  </Heading>
                  <Text
                    className="text-ui-fg-subtle mt-1 break-words"
                    size="small"
                  >
                    {/* Plain text for SKU and RAW/GRADED: they are descriptive
                        values, not statuses — same call the list page makes. */}
                    {item.sku} &middot;{' '}
                    {item.graded ? t('inventory.graded') : t('inventory.raw')}
                    {!item.is_card && (
                      <span className="ml-1">({t('inventory.notACard')})</span>
                    )}
                  </Text>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
                {stats.map((s) => (
                  <div key={s.label} title={s.title}>
                    <Text size="small" className="text-ui-fg-subtle">
                      {s.label}
                    </Text>
                    <Text className={`tabular-nums ${s.tone ?? ''}`}>
                      {s.value}
                    </Text>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Container>

      {item && associated ? (
        <Container className="p-0">
          <div className="px-6 py-4">
            {/* The count and the badges below it are EQUAL BY CONSTRUCTION,
                not by coincidence: listingCountByHandle (which feeds
                listing_count, and the list page's "Listing Show" column) sums
                a Set of pack_id plus one per matching rank reward, and this
                route builds `packs` from the same [...new Set(pack_id)] over
                the byte-identical {card_id, kind: null} filter. Drop either
                dedupe and this heading disagrees with its own badge list AND
                with the list page's column for the same card. */}
            <Heading level="h2">
              {t('inventory.detail.associated', { n: item.listing_count })}
            </Heading>
            <div className="mt-3 flex flex-wrap gap-2">
              {/* Badge is for TAGS — pack membership and a rank slot are tags,
                  not statuses, so no StatusBadge here. */}
              {associated.packs.map((p) => (
                <Badge key={p.slug} size="2xsmall">
                  {p.title}
                </Badge>
              ))}
              {associated.rank_rewards.map((r) => (
                <Badge
                  key={`${r.stage_number}-${r.rank}`}
                  size="2xsmall"
                  color="purple"
                >
                  {t('inventory.detail.rankReward', {
                    stage: r.stage_number,
                    rank: r.rank,
                  })}
                </Badge>
              ))}
              {associated.packs.length === 0 &&
                associated.rank_rewards.length === 0 && (
                  <Text className="text-ui-fg-subtle" size="small">
                    {t('inventory.detail.notListed')}
                  </Text>
                )}
            </div>
          </div>
        </Container>
      ) : null}

      {item && movements ? (
        <Container className="p-0">
          <div className="px-6 py-4">
            <Heading level="h2">{t('inventory.detail.history')}</Heading>
          </div>

          {/* Body-swap again rather than a spanning empty row: Table.Cell has no
              colSpan in @medusajs/ui's typing (its props come from
              HTMLAttributes, unlike HeaderCell's TdHTMLAttributes), so the
              natural empty state is a TS2322. */}
          {movements.rows.length === 0 ? (
            <div className="border-t px-6 py-8">
              <Text className="text-ui-fg-subtle">
                {t('inventory.detail.noMovements')}
              </Text>
            </div>
          ) : (
            <div
              className="overflow-x-auto border-t"
              tabIndex={0}
              role="region"
              aria-label={t('inventory.detail.history')}
            >
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>
                      {t('inventory.detail.when')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('inventory.detail.kindCol')}
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t('inventory.detail.qty')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('inventory.detail.ref')}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {movements.rows.map((m) => (
                    <Table.Row key={m.id}>
                      <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                        {orderDateTime(m.created_at)}
                      </Table.Cell>
                      {/* defaultValue, not a bare lookup: the model defines
                          seven kinds and only 'purchase' is written today, so a
                          kind wired by a later epic renders its raw token
                          rather than an empty cell (the rule
                          deliveryStatusLabel documents). */}
                      <Table.Cell className="whitespace-nowrap">
                        {t(`inventory.detail.kind.${m.kind}`, {
                          defaultValue: m.kind,
                        })}
                      </Table.Cell>
                      {/* qty is SIGNED and is a model.number(), not a bigNumber
                          — no Number() wrap needed, and a reversal's negative
                          renders with its own minus sign. */}
                      <Table.Cell className="text-right tabular-nums">
                        {m.qty}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-muted break-all">
                        {m.ref_id}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}

          {/* Gated on total: with an empty log the pager would render
              "0-0 of 0" and two dead buttons under the empty state. */}
          {movements.total > 0 ? (
            <Pager
              page={page}
              onPage={setPage}
              pageSize={movements.limit}
              count={movements.rows.length}
              total={movements.total}
            />
          ) : null}
        </Container>
      ) : null}
    </div>
  );
};

export default InventoryItemDetailPage;
