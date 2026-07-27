import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Prompt,
  StatusBadge,
  Table,
  Tabs,
  Text,
  toast,
} from '@medusajs/ui';
import { ArrowLeft } from '@medusajs/icons';
import {
  useAdjustCredits,
  useCustomerAudit,
  useCustomerDetail,
  useCustomerGacha,
  useCustomerPulls,
  useCustomerTransactions,
  useFreezeCustomer,
  usePayoutDetails,
  useReferralTree,
  useCustomerCommissions,
  useReverseCommission,
  useSavePayoutDetails,
  useSuspendCommission,
  useUnfreezeCustomer,
  useUnsuspendCommission,
} from '../../../lib/queries';
import { orderDateTime, rm } from '../../../lib/format';
import type {
  AdminCommissionRow,
  CustomerAudit,
  PayoutDetails,
  ReferralTree,
  ReferralTreeNode,
} from '../../../lib/admin-rest';
import { resolveImageUrl } from '../../../lib/image-url';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';

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

// Which modal is open. null = none.
type ModalKind =
  | 'freeze'
  | 'unfreeze'
  | 'credits'
  | 'reverse'
  | 'suspend'
  | 'unsuspend';

// One line per tab — Task 10 adds 'lvl' | 'orders' | 'pulls' here and one
// Tabs.Trigger + one conditional render below.
type TabKey = 'profile' | 'wallet' | 'vault' | 'history';

// ── Tab bodies ──────────────────────────────────────────────────────────────
// One component per tab, following routes/deliveries/page.tsx: an inactive
// tab's queries never fire — the payout details, the credit-ledger page and the
// vaulted-pull page are three requests the operator doesn't pay for until they
// ask for them.
//
// The trade is that a tab body's OWN state resets when the tab unmounts (a
// table offset, an unsaved bank draft — verified, not assumed). State that has
// to outlive a tab switch is therefore held by the parent instead: the modal,
// and History's two table offsets. Nothing here is destructive on reset — the
// bank form only ever writes on an explicit Save.
//
// Each tab body returns its OWN top-level Container(s), not a wrapper <div>:
// the page root is a `flex flex-col gap-y-3`, so a wrapper would swallow the
// gap between a tab's sections (Profile has two, History three).
//
// History is the exception that keeps its queries in the PARENT. The header's
// frozen badge and its Freeze/Unfreeze button read `account_state` off the
// very same /audit response, so that query cannot move down here — and the
// referral/commission pair rides along with it rather than splitting one
// section's data across two owners. This tab is a JSX move, nothing else.

const BankForm = ({
  customerId,
  seed,
}: {
  customerId: string;
  seed: PayoutDetails | null;
}) => {
  const { t } = useTranslation();
  const save = useSavePayoutDetails();
  const [bankName, setBankName] = useState(seed?.bank_name ?? '');
  const [account, setAccount] = useState(seed?.bank_account_number ?? '');
  const [holder, setHolder] = useState(seed?.account_holder_name ?? '');

  // Compared TRIMMED against what the server holds, because submit trims too:
  // after a save the draft and the refreshed seed agree and Save re-disables
  // itself instead of offering to write the same row again.
  const unchanged =
    bankName.trim() === (seed?.bank_name ?? '') &&
    account.trim() === (seed?.bank_account_number ?? '') &&
    holder.trim() === (seed?.account_holder_name ?? '');

  // No toast here — useSavePayoutDetails already fires one on success and
  // another on error.
  const submit = () =>
    save.mutate({
      id: customerId,
      details: {
        bank_name: bankName.trim(),
        bank_account_number: account.trim(),
        // The column is nullable; '' would persist as an empty holder name.
        account_holder_name: holder.trim() || null,
      },
    });

  return (
    <div className="flex flex-col gap-4 border-t px-6 py-4">
      <div className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="payout-bank-name" size="small">
            {t('players.bankName')}
          </Label>
          <Input
            id="payout-bank-name"
            value={bankName}
            onChange={(e) => setBankName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="payout-bank-account" size="small">
            {t('players.bankAccount')}
          </Label>
          <Input
            id="payout-bank-account"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="payout-holder" size="small">
            {t('players.accountHolder')}
          </Label>
          <Input
            id="payout-holder"
            value={holder}
            onChange={(e) => setHolder(e.target.value)}
          />
        </div>
      </div>
      <div>
        <Button
          size="small"
          onClick={submit}
          isLoading={save.isPending}
          disabled={unchanged || !bankName.trim() || !account.trim()}
        >
          {t('players.saveBank')}
        </Button>
      </div>
    </div>
  );
};

const ProfileTab = ({ customerId }: { customerId: string | null }) => {
  const { t } = useTranslation();
  const { data, isError } = useCustomerDetail(customerId);
  const { data: payout, isError: payoutError } = usePayoutDetails(customerId);
  const customer = data?.customer;
  // metadata is Record<string, unknown> — the handle is only renderable once
  // it has been narrowed to a non-empty string.
  const handle = customer?.metadata?.handle;
  const referralCode = typeof handle === 'string' && handle ? handle : '—';
  const name =
    [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || '—';

  return (
    <>
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('players.identityTitle')}</Heading>
        </div>
        {isError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !customer ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : (
          // break-words (inherited by every dd) so a long email or handle wraps
          // instead of widening the 1fr track past the container.
          <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 break-words border-t px-6 py-4 text-sm">
            <dt className="text-ui-fg-subtle">{t('players.name')}</dt>
            <dd>{name}</dd>
            <dt className="text-ui-fg-subtle">{t('players.email')}</dt>
            <dd>{customer.email}</dd>
            <dt className="text-ui-fg-subtle">{t('players.phone')}</dt>
            <dd>{customer.phone ?? '—'}</dd>
            <dt className="text-ui-fg-subtle">{t('players.referralCode')}</dt>
            <dd>{referralCode}</dd>
            <dt className="text-ui-fg-subtle">{t('players.registered')}</dt>
            <dd className="tabular-nums">{orderDateTime(customer.created_at)}</dd>
          </dl>
        )}
      </Container>

      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('players.bankTitle')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('players.bankSubtitle')}
          </Text>
        </div>
        {payoutError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !payout || !customerId ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : (
          // Mounted only once the saved row is in hand, so the three inputs can
          // seed from useState initialisers. Seeding an already-mounted form
          // needs an effect, and that effect races the operator's typing on
          // every background refetch.
          <BankForm customerId={customerId} seed={payout.details} />
        )}
      </Container>
    </>
  );
};

const WalletTab = ({ customerId }: { customerId: string | null }) => {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  // Same query key as the header's — React Query serves it from cache, so this
  // is a read of already-fetched data, not a second request.
  const { data: view } = useCustomerGacha(customerId);
  const { data, isError } = useCustomerTransactions(customerId, page);
  const rows = data?.items ?? [];

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Text size="small" className="text-ui-fg-subtle">
          {t('customer360.balance')}
        </Text>
        <Heading level="h1" className="mt-1 tabular-nums">
          {view ? rm(view.balance) : '—'}
        </Heading>
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
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label="Credit ledger table"
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('support.when')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('support.reason')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('support.amount')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>{t('support.note')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((tx) => (
                  <Table.Row key={tx.id}>
                    <Table.Cell className="text-ui-fg-subtle tabular-nums whitespace-nowrap">
                      {orderDateTime(tx.created_at)}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="2xsmall">{tx.reason}</Badge>
                    </Table.Cell>
                    {/* Debits red, credits left at the base colour — same
                        convention as the support desk's ledger. */}
                    <Table.Cell
                      className={`text-right tabular-nums ${tx.amount < 0 ? 'text-ui-fg-error' : ''}`}
                    >
                      {rm(tx.amount)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle max-w-[24rem] truncate">
                      {tx.reference ?? '—'}
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

const VaultTab = ({ customerId }: { customerId: string | null }) => {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const { data: view } = useCustomerGacha(customerId);
  // status:'vaulted' is applied server-side AND keyed, so this never shows a
  // bought-back card and never collides with the support page's full history.
  const { data, isError } = useCustomerPulls(customerId, page, {
    status: 'vaulted',
  });
  const rows = data?.items ?? [];

  return (
    <Container className="p-0">
      <div className="grid grid-cols-1 gap-px bg-ui-border-base md:grid-cols-3">
        <div className="bg-ui-bg-subtle px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {t('customer360.vault')}
          </Text>
          <Heading level="h1" className="mt-1 tabular-nums">
            {view ? view.vault.count : '—'}
          </Heading>
        </div>
        <div className="bg-ui-bg-subtle px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {t('players.vaultFmv')}
          </Text>
          <Heading level="h1" className="mt-1 tabular-nums">
            {view ? rm(view.vault.market_value) : '—'}
          </Heading>
        </div>
        <div className="bg-ui-bg-subtle px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {t('players.vaultPrice')}
          </Text>
          <Heading level="h1" className="mt-1 tabular-nums">
            {view ? rm(view.vault.display_value) : '—'}
          </Heading>
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
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label="Vaulted cards table"
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('support.card')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('players.qty')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('support.value')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>{t('players.pulledAt')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((p) => (
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
                          {p.card?.name ?? '—'}
                        </span>
                      </div>
                    </Table.Cell>
                    {/* One pack open yields one card. */}
                    <Table.Cell className="text-right tabular-nums">1</Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {rm(p.card?.market_value ?? null)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle tabular-nums whitespace-nowrap">
                      {orderDateTime(p.rolled_at)}
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

const HistoryTab = ({
  treeQ,
  commissionsQ,
  auditQ,
  commPage,
  setCommPage,
  auditPage,
  setAuditPage,
  openModal,
}: {
  treeQ: UseQueryResult<ReferralTree>;
  commissionsQ: UseQueryResult<{ commissions: AdminCommissionRow[] }>;
  auditQ: UseQueryResult<CustomerAudit>;
  commPage: number;
  setCommPage: (page: number) => void;
  auditPage: number;
  setAuditPage: (page: number) => void;
  openModal: (kind: ModalKind, commId?: string) => void;
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { data: tree, isError: treeError } = treeQ;
  const { data: commissionsData, isError: commissionsError } = commissionsQ;
  const { data: auditData, isError: auditError } = auditQ;

  const commissions = commissionsData?.commissions ?? [];
  const nodes: ReferralTreeNode[] = tree ? [tree.root, ...tree.nodes] : [];
  const auditActions = (auditData?.actions ?? [])
    // ponytail: belt-and-suspenders — backend already orders DESC; sort client-side to guarantee newest-first regardless of fetch order
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const accountState = auditData?.account_state ?? null;

  return (
    <>
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

        {treeError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !tree ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Referral tree table">
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
          </div>
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

        {commissionsError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !commissionsData ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : commissions.length === 0 ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">{t('customer360.commissionsEmpty')}</Text>
          </div>
        ) : (
          <>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Commissions table">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t('customer360.commGen')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.commKind')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.commStatus')}</Table.HeaderCell>
                <Table.HeaderCell className="text-right">{t('customer360.commAmount')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.commOpener')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.commMatures')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.commActions')}</Table.HeaderCell>
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
                    {rm(parseFloat(c.amount))}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {c.opener.handle ?? c.opener.customer_id ?? '—'}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {c.matures_at
                      ? new Date(c.matures_at).toLocaleDateString('en-US')
                      : '—'}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex items-center gap-1">
                      {c.status !== 'reversed' && (
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => openModal('reverse', c.id)}
                        >
                          {t('customer360.commReverse')}
                        </Button>
                      )}
                      {c.status === 'available' && (
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => openModal('suspend', c.id)}
                        >
                          {t('customer360.commSuspend')}
                        </Button>
                      )}
                      {c.status === 'suspended' && (
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => openModal('unsuspend', c.id)}
                        >
                          {t('customer360.commUnsuspend')}
                        </Button>
                      )}
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          </div>
          <Pager
            page={commPage}
            onPage={setCommPage}
            pageSize={50}
            count={commissions.length}
            total={null}
          />
          </>
        )}
      </Container>

      {/* ── Audit timeline ──────────────────────────────────────── */}
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('customer360.auditTitle')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('customer360.auditSubtitle')}
          </Text>
        </div>

        {/* Account state panel */}
        {accountState && (
          <div className="border-t px-6 py-4">
            <Text size="small" className="text-ui-fg-subtle mb-2">
              {t('customer360.accountStateTitle')}
            </Text>
            <div className="flex items-center gap-3">
              {accountState.frozen ? (
                <Badge size="small" color="red">
                  {t('customer360.accountStateFrozen')}
                </Badge>
              ) : (
                <Badge size="small" color="green">
                  {t('customer360.accountStateActive')}
                </Badge>
              )}
              {accountState.freeze_cause && (
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.accountStateCause')}: {accountState.freeze_cause}
                </Text>
              )}
              {accountState.frozen_at && (
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.accountStateSince', {
                    date: new Date(accountState.frozen_at).toLocaleDateString('en-US'),
                  })}
                </Text>
              )}
            </div>
            {accountState.freeze_reason && (
              <Text size="small" className="text-ui-fg-subtle mt-1">
                &ldquo;{accountState.freeze_reason}&rdquo;
              </Text>
            )}
          </div>
        )}

        {auditError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !auditData ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : auditActions.length === 0 ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">{t('customer360.auditEmpty')}</Text>
          </div>
        ) : (
          <>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t('customer360.auditWhen')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.auditAction')}</Table.HeaderCell>
                <Table.HeaderCell>{t('customer360.auditReason')}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {auditActions.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell className="text-ui-fg-subtle tabular-nums whitespace-nowrap">
                    {new Date(row.created_at).toLocaleString('en-US')}
                  </Table.Cell>
                  <Table.Cell>
                    {/* ponytail: t() falls back to raw action key if label missing */}
                    {t(`customer360.action.${row.action}`, row.action)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {row.reason ?? '—'}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          <Pager
            page={auditPage}
            onPage={setAuditPage}
            pageSize={50}
            count={auditActions.length}
            total={null}
          />
          </>
        )}
      </Container>
    </>
  );
};

const Customer360Page = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const customerId = id || null;

  const [tab, setTab] = useState<TabKey>('profile');

  // Offset pages for the two paged tables. Both endpoints serve 50/page.
  const [commPage, setCommPage] = useState(0);
  const [auditPage, setAuditPage] = useState(0);
  // Reset both offsets when the viewed customer changes (the tree's "open
  // subtree" button navigates to another /customers/:id without remounting) so
  // a stale offset can't leak into the next customer's tables. Render-phase
  // reset runs before the fetch — no wasted (newId, stalePage) request — and is
  // a harmless no-op if the route does remount.
  const [prevId, setPrevId] = useState(customerId);
  if (customerId !== prevId) {
    setPrevId(customerId);
    setCommPage(0);
    setAuditPage(0);
  }

  const { data: view, isError: viewError } = useCustomerGacha(customerId);
  const treeQ = useReferralTree(customerId);
  const commissionsQ = useCustomerCommissions(customerId, commPage);
  const auditQ = useCustomerAudit(customerId, auditPage);

  const freeze = useFreezeCustomer();
  const unfreeze = useUnfreezeCustomer();
  const adjustCredits = useAdjustCredits();
  const reverseComm = useReverseCommission();
  const suspendComm = useSuspendCommission();
  const unsuspendComm = useUnsuspendCommission();

  // The header's badge and its Freeze/Unfreeze button read the account state
  // off the audit response — which is why that query stays here and not in the
  // History tab body (see the tab-body note above).
  const isFrozen = auditQ.data?.account_state?.frozen ?? false;

  // ── Modal state ─────────────────────────────────────────────────────────────
  const [modal, setModal] = useState<ModalKind | null>(null);
  // shared reason field (freeze / unfreeze / reverse / suspend / unsuspend)
  const [reason, setReason] = useState('');
  // credits-specific fields
  const [creditAmount, setCreditAmount] = useState('');
  const [creditNote, setCreditNote] = useState('');
  // target commission id for commission actions
  const [targetCommId, setTargetCommId] = useState('');

  function openModal(kind: ModalKind, commId = '') {
    setReason('');
    setCreditAmount('');
    setCreditNote('');
    setTargetCommId(commId);
    setModal(kind);
  }
  function closeModal() { setModal(null); }

  // ── Action handlers (called from Prompt.Action) ──────────────────────────
  function applyFreeze() {
    if (!customerId || !reason.trim()) return;
    closeModal();
    freeze.mutate({ id: customerId, reason });
  }

  function applyUnfreeze() {
    if (!customerId || !reason.trim()) return;
    closeModal();
    unfreeze.mutate({ id: customerId, reason });
  }

  function applyAdjustCredits() {
    if (!customerId) return;
    const amount = Number(creditAmount.trim());
    // Reject NaN and a no-op zero adjustment (matches support/page.tsx). Both
    // signs are intended (negative = debit, positive = credit); only exactly 0
    // is meaningless.
    if (!Number.isFinite(amount) || amount === 0) {
      toast.error(t('support.adjustInvalid'));
      return;
    }
    if (!creditNote.trim()) return;
    closeModal();
    adjustCredits.mutate(
      { id: customerId, amount, note: creditNote },
      { onSuccess: () => toast.success('Credits adjusted') },
    );
  }

  function applyCommAction() {
    if (!customerId || !targetCommId || !reason.trim()) return;
    const vars = { commId: targetCommId, customerId, reason };
    closeModal();
    if (modal === 'reverse') reverseComm.mutate(vars);
    else if (modal === 'suspend') suspendComm.mutate(vars);
    else if (modal === 'unsuspend') unsuspendComm.mutate(vars);
  }

  // ── Prompt titles / descriptions per modal kind ──────────────────────────
  const MODAL_TITLE: Record<ModalKind, string> = {
    freeze:    t('customer360.modalFreezeTitle'),
    unfreeze:  t('customer360.modalUnfreezeTitle'),
    credits:   t('customer360.modalCreditsTitle'),
    reverse:   t('customer360.modalReverseTitle'),
    suspend:   t('customer360.modalSuspendTitle'),
    unsuspend: t('customer360.modalUnsuspendTitle'),
  };

  const MODAL_DESC: Record<ModalKind, string> = {
    freeze:    t('customer360.modalFreezeDesc'),
    unfreeze:  t('customer360.modalUnfreezeDesc'),
    credits:   t('customer360.modalCreditsDesc'),
    reverse:   t('customer360.modalReverseDesc'),
    suspend:   t('customer360.modalSuspendDesc'),
    unsuspend: t('customer360.modalUnsuspendDesc'),
  };

  function handleConfirm() {
    if (modal === 'freeze')     applyFreeze();
    else if (modal === 'unfreeze')   applyUnfreeze();
    else if (modal === 'credits')    applyAdjustCredits();
    else applyCommAction();
  }

  // Mirror applyAdjustCredits' validation: Number('abc') is NaN (and 'Infinity'
  // parses), neither === 0, so without the finite check the confirm button lit
  // up for garbage input only to be rejected after the click.
  const creditNum = Number(creditAmount.trim());
  const confirmDisabled =
    modal === 'credits'
      ? !creditAmount.trim() ||
        !Number.isFinite(creditNum) ||
        creditNum === 0 ||
        !creditNote.trim()
      : !reason.trim();

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
              {isFrozen && (
                <Badge size="small" color="red">
                  {t('customer360.frozen')}
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
            {viewError && (
              <Text size="small" className="text-ui-fg-error mt-1">
                Failed to load.
              </Text>
            )}
          </div>
          {view && (
            <div className="flex items-center gap-2">
              {isFrozen ? (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => openModal('unfreeze')}
                  isLoading={unfreeze.isPending}
                >
                  {t('customer360.btnUnfreeze')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => openModal('freeze')}
                  isLoading={freeze.isPending}
                >
                  {t('customer360.btnFreeze')}
                </Button>
              )}
              <Button
                variant="secondary"
                size="small"
                onClick={() => openModal('credits')}
                isLoading={adjustCredits.isPending}
              >
                {t('customer360.btnAdjustCredits')}
              </Button>
            </div>
          )}
        </div>

        {view && (
          <div className="grid grid-cols-1 gap-px border-t bg-ui-border-base md:grid-cols-3">
            <div className="bg-ui-bg-subtle px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                {t('customer360.balance')}
              </Text>
              <Heading level="h1" className="mt-1 tabular-nums">
                {rm(view.balance)}
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
                {rm(view.vault.market_value)} FMV
              </Text>
            </div>
            {view.vip && (
              <div className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.vipSpend')}
                </Text>
                <Heading level="h1" className="mt-1 tabular-nums">
                  {rm(view.vip.spend)}
                </Heading>
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.vipPeakLevel', { level: view.vip.highest_level_ever })}
                </Text>
              </div>
            )}
          </div>
        )}
      </Container>

      {/* ── Prompt modal — single instance, content varies by modal kind ─── */}
      <Prompt open={modal !== null} onOpenChange={(open) => { if (!open) closeModal(); }}>
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>{modal ? MODAL_TITLE[modal] : ''}</Prompt.Title>
            <Prompt.Description>{modal ? MODAL_DESC[modal] : ''}</Prompt.Description>
          </Prompt.Header>

          <div className="flex flex-col gap-3 px-6 pb-2">
            {modal === 'credits' ? (
              <>
                <div>
                  <Label htmlFor="c360-amount" size="small">
                    {t('support.adjustAmount')}
                  </Label>
                  <Input
                    id="c360-amount"
                    value={creditAmount}
                    placeholder={t('support.adjustAmount')}
                    onChange={(e) => setCreditAmount(e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <Label htmlFor="c360-note" size="small">
                    {t('support.adjustNote')}
                  </Label>
                  <Input
                    id="c360-note"
                    value={creditNote}
                    placeholder={t('support.adjustNote')}
                    onChange={(e) => setCreditNote(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <div>
                <Label htmlFor="c360-reason" size="small">
                  {t('customer360.modalReasonLabel')}
                </Label>
                <Input
                  id="c360-reason"
                  value={reason}
                  placeholder={t('customer360.modalReasonPlaceholder')}
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus
                />
              </div>
            )}
          </div>

          <Prompt.Footer>
            <Prompt.Cancel>{t('support.adjustCancel')}</Prompt.Cancel>
            <Prompt.Action onClick={handleConfirm} disabled={confirmDisabled}>
              {t('support.adjustConfirm')}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>

      {/* ── Tabs ───────────────────────────────────────────────── */}
      <Container className="p-0">
        <div className="px-6 py-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
            <Tabs.List aria-label="Player detail sections">
              <Tabs.Trigger value="profile">{t('players.tabProfile')}</Tabs.Trigger>
              <Tabs.Trigger value="wallet">{t('players.tabWallet')}</Tabs.Trigger>
              <Tabs.Trigger value="vault">{t('players.tabVault')}</Tabs.Trigger>
              <Tabs.Trigger value="history">{t('players.tabHistory')}</Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </div>
      </Container>

      {/* key={id}: the tree's "open subtree" button navigates to another
          /customers/:id WITHOUT remounting this route, so without a key a tab
          body would keep the previous player's table offset and — worse — the
          previous player's bank-form draft. */}
      {tab === 'profile' && <ProfileTab key={id} customerId={customerId} />}
      {tab === 'wallet' && <WalletTab key={id} customerId={customerId} />}
      {tab === 'vault' && <VaultTab key={id} customerId={customerId} />}
      {tab === 'history' && (
        <HistoryTab
          treeQ={treeQ}
          commissionsQ={commissionsQ}
          auditQ={auditQ}
          commPage={commPage}
          setCommPage={setCommPage}
          auditPage={auditPage}
          setAuditPage={setAuditPage}
          openModal={openModal}
        />
      )}
    </div>
  );
};

export default Customer360Page;
