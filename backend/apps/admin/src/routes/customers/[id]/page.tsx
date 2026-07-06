import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  Text,
  toast,
} from '@medusajs/ui';
import { ArrowLeft } from '@medusajs/icons';
import {
  useAdjustCredits,
  useCustomerAudit,
  useCustomerGacha,
  useFreezeCustomer,
  useReferralTree,
  useCustomerCommissions,
  useReverseCommission,
  useSuspendCommission,
  useUnfreezeCustomer,
  useUnsuspendCommission,
} from '../../../lib/queries';
import { rm } from '../../../lib/format';
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

// Which modal is open. null = none.
type ModalKind =
  | 'freeze'
  | 'unfreeze'
  | 'credits'
  | 'reverse'
  | 'suspend'
  | 'unsuspend';

const Customer360Page = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const customerId = id || null;

  const { data: view } = useCustomerGacha(customerId);
  const { data: tree } = useReferralTree(customerId);
  const { data: commissionsData } = useCustomerCommissions(customerId);
  const { data: auditData } = useCustomerAudit(customerId);

  const freeze = useFreezeCustomer();
  const unfreeze = useUnfreezeCustomer();
  const adjustCredits = useAdjustCredits();
  const reverseComm = useReverseCommission();
  const suspendComm = useSuspendCommission();
  const unsuspendComm = useUnsuspendCommission();

  const commissions = commissionsData?.commissions ?? [];
  const nodes: ReferralTreeNode[] = tree ? [tree.root, ...tree.nodes] : [];
  const auditActions = (auditData?.actions ?? [])
    // ponytail: belt-and-suspenders — backend already orders DESC; sort client-side to guarantee newest-first regardless of fetch order
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const accountState = auditData?.account_state ?? null;
  const isFrozen = accountState?.frozen ?? false;

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
    if (!Number.isFinite(amount)) {
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

  const confirmDisabled =
    modal === 'credits'
      ? !creditAmount.trim() || !creditNote.trim()
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

        {!commissionsData ? (
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
                  <Table.Cell>
                    <div className="flex items-center gap-1">
                      {c.status !== 'reversed' && (
                        <button
                          type="button"
                          className="text-ui-fg-subtle hover:text-ui-fg-base text-xs underline"
                          onClick={() => openModal('reverse', c.id)}
                        >
                          {t('customer360.commReverse')}
                        </button>
                      )}
                      {c.status === 'available' && (
                        <button
                          type="button"
                          className="text-ui-fg-subtle hover:text-ui-fg-base text-xs underline"
                          onClick={() => openModal('suspend', c.id)}
                        >
                          {t('customer360.commSuspend')}
                        </button>
                      )}
                      {c.status === 'suspended' && (
                        <button
                          type="button"
                          className="text-ui-fg-subtle hover:text-ui-fg-base text-xs underline"
                          onClick={() => openModal('unsuspend', c.id)}
                        >
                          {t('customer360.commUnsuspend')}
                        </button>
                      )}
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
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

        {!auditData ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">…</Text>
          </div>
        ) : auditActions.length === 0 ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">{t('customer360.auditEmpty')}</Text>
          </div>
        ) : (
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
        )}
      </Container>
    </div>
  );
};

export default Customer360Page;
