import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Container,
  Heading,
  StatusBadge,
  Table,
  Text,
} from '@medusajs/ui';
import { ArrowLeft } from '@medusajs/icons';
import {
  useCustomerGacha,
  useReferralTree,
  useCustomerCommissions,
} from '../../../lib/queries';
import { usd } from '../../../lib/format';
import type { ReferralTreeNode } from '../../../lib/admin-rest';

// ponytail: no config export — keeps route out of sidebar nav (mirrors packs/[slug]/page.tsx)

const COMMISSION_STATUS_COLOR: Record<
  string,
  'green' | 'orange' | 'red' | 'grey'
> = {
  available: 'green',
  pending: 'orange',
  suspended: 'red',
  reversed: 'grey',
};

const Customer360Page = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const customerId = id || null;

  const { data: view } = useCustomerGacha(customerId);
  const { data: tree } = useReferralTree(customerId);
  const { data: commissionsData } = useCustomerCommissions(customerId);

  const commissionsLoading = !commissionsData;
  const commissions = commissionsData?.commissions ?? [];
  const nodes: ReferralTreeNode[] = tree ? [tree.root, ...tree.nodes] : [];

  return (
    <div className="flex flex-col gap-y-3">
      {/* ── Header ─────────────────────────────────────────────── */}
      <Container className="p-0">
        <div className="flex items-start justify-between gap-4 px-6 py-4">
          <div>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="text-ui-fg-subtle hover:text-ui-fg-base mb-2 flex items-center gap-1 text-sm"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('customer360.back')}
            </button>
            <div className="flex items-center gap-2">
              <Heading level="h2">
                {view?.customer.email ?? id}
              </Heading>
              {view?.vip && (
                <Badge size="small" color="purple">
                  {t('customer360.vipLevel', { level: view.vip.level })}
                </Badge>
              )}
            </div>
            {view?.customer.created_at && (
              <Text className="text-ui-fg-subtle mt-1" size="small">
                {t('customer360.memberSince', {
                  date: new Date(view.customer.created_at).toLocaleDateString('en-US'),
                })}
              </Text>
            )}
          </div>
        </div>

        {view && (
          <div className="grid grid-cols-1 gap-px border-t bg-ui-border-base md:grid-cols-3">
            <div className="bg-ui-bg-subtle px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                {t('customer360.balance')}
              </Text>
              <Heading level="h1" className="mt-1 tabular-nums">
                {usd(view.balance)}
              </Heading>
            </div>
            <div className="bg-ui-bg-subtle px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                {t('customer360.vault')}
              </Text>
              <Heading level="h1" className="mt-1 tabular-nums">
                {view.vault.count}
              </Heading>
              <Text size="small" className="text-ui-fg-subtle">
                {usd(view.vault.market_value)} FMV
              </Text>
            </div>
            {view.vip && (
              <div className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.vipSpend')}
                </Text>
                <Heading level="h1" className="mt-1 tabular-nums">
                  RM {view.vip.spend.toFixed(2)}
                </Heading>
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.vipPeakLevel', { level: view.vip.highest_level_ever })}
                </Text>
              </div>
            )}
          </div>
        )}
      </Container>

      {/* ── Referral tree ───────────────────────────────────────── */}
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('customer360.treeTitle')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('customer360.treeSubtitle')}
          </Text>
        </div>

        {tree?.truncated && (
          <div className="border-t bg-ui-tag-orange-bg px-6 py-3">
            <Text size="small" className="text-ui-tag-orange-text">
              {t('customer360.treeTruncated')}
            </Text>
          </div>
        )}

        {!tree ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">…</Text>
          </div>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t('customer360.treeHandle')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.treeDepth')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.treeRecruits')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.treeVip')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.treeFrozen')}</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {nodes.map((node) => (
                <Table.Row key={node.customer_id}>
                  <Table.Cell>
                    {/* indent by depth using padding */}
                    <span style={{ paddingLeft: `${node.depth * 20}px` }} className="flex flex-col">
                      <span className="font-medium">
                        {node.handle ?? node.email ?? node.customer_id}
                      </span>
                      {node.handle && node.email && (
                        <span className="text-ui-fg-subtle text-xs">{node.email}</span>
                      )}
                    </span>
                  </Table.Cell>
                  <Table.Cell className="tabular-nums">{node.depth}</Table.Cell>
                  <Table.Cell className="tabular-nums">{node.direct_recruit_count}</Table.Cell>
                  <Table.Cell>
                    {node.vip_level !== null ? (
                      <Badge size="2xsmall" color="purple">
                        {t('customer360.vipLevelShort', { level: node.vip_level })}
                      </Badge>
                    ) : (
                      <span className="text-ui-fg-subtle">—</span>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {node.frozen ? (
                      <Badge size="2xsmall" color="red">
                        {t('customer360.frozen')}
                      </Badge>
                    ) : (
                      <span className="text-ui-fg-subtle">—</span>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {node.has_more_depth && (
                      <button
                        type="button"
                        onClick={() => navigate(`/customers/${node.customer_id}`)}
                        className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover text-xs underline"
                      >
                        {t('customer360.treeOpenSubtree')}
                      </button>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Container>

      {/* ── Commissions ─────────────────────────────────────────── */}
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('customer360.commissionsTitle')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('customer360.commissionsSubtitle')}
          </Text>
        </div>

        {commissionsLoading ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">…</Text>
          </div>
        ) : commissions.length === 0 ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">{t('customer360.commissionsEmpty')}</Text>
          </div>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t('customer360.commGen')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.commKind')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.commStatus')}</Table.HeaderCell>
                <Table.HeaderCell className="text-right">{t('customer360.commAmount')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.commOpener')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.commMatures')}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {commissions.map((c) => (
                <Table.Row key={c.id}>
                  <Table.Cell className="tabular-nums">{c.generation}</Table.Cell>
                  <Table.Cell>
                    <Badge size="2xsmall">{c.kind}</Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge
                      color={COMMISSION_STATUS_COLOR[c.status] ?? 'grey'}
                    >
                      {c.status}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    RM {parseFloat(c.amount).toFixed(2)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {c.opener.handle ?? c.opener.customer_id ?? '—'}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {c.matures_at
                      ? new Date(c.matures_at).toLocaleDateString('en-US')
                      : '—'}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Container>
    </div>
  );
};

export default Customer360Page;
