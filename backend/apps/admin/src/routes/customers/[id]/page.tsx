import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Container,
  Heading,
  IconButton,
  Input,
  Label,
  Prompt,
  Tabs,
  Text,
  toast,
} from '@medusajs/ui';
import { ArrowLeft } from '@medusajs/icons';
import type { Permission } from '@mercurjs/dashboard-sdk';
import { usePermissions } from '@mercurjs/admin';
import {
  useAdjustCredits,
  useCustomerAudit,
  useCustomerDetail,
  useCustomerGacha,
  useCustomerReferral,
  useCustomerMoney,
  useFreezeCustomer,
  useUnfreezeCustomer,
} from '../../../lib/queries';
import { timeAgo } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { GiftAndBonusPanels } from './gift-and-bonus';
import { LuckyDrawTicketsPanel } from './lucky-draw-tickets';
import { MoneySummary, PeriodsCard, PlayCard } from './MoneyCards';
import { HistoryTab } from './HistoryTab';
import { LevelTab } from './LevelTab';
import { OrdersTab } from './OrdersTab';
import { PaymentsTab } from './PaymentsTab';
import { ProfileTab } from './ProfileTab';
import { PullsTab } from './PullsTab';
import { VaultTab } from './VaultTab';
import { WalletTab } from './WalletTab';

// ponytail: no config export — keeps route out of sidebar nav (mirrors packs/[slug]/page.tsx)

// This route DELIBERATELY takes over core Medusa's /customers/:id. "Players" is
// a UI/i18n rename only and the URLs stay /customers/:id (epic 2 plan, merged in
// #271), so `mergeRoutes` in @mercurjs/admin matches this file's path against
// core's and our `lazy` replaces core's customer-detail page. Verified in the
// browser, not just read: /dashboard/customers/:id renders THIS page.
//
// The consequence: core's customer-detail children — `edit`, `create-address`,
// `add-customer-groups`, `:order_id/transfer`, `metadata/edit` (read from the
// bundle's route table) — survive the merge but now sit under a component with
// no <Outlet/>. Verified for `edit`: /customers/:id/edit renders this page and
// no modal, the URL being the only thing that changes; the others share that
// merge path. Nothing links to them anymore either, since core's detail page is
// what linked to them. Restoring one would be new work (an <Outlet/> plus a
// button), not a bug fix. Any NEW admin route must be checked against the core
// route table first — see docs/adr/0002-admin-dashboard-ui-stack.md.

// Which modal is open. null = none.
type ModalKind = 'freeze' | 'unfreeze' | 'credits';

const TABS = [
  'overview',
  'wallet',
  'payments',
  'vault',
  'orders',
  'pulls',
  'gifts',
  'lvl',
  'profile',
  'history',
] as const;
type TabKey = (typeof TABS)[number];

// Two letters for the avatar: initials of the name, else the email's start
// (the Players list's rule).
const initials = (name: string, email: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words[0][0] + words[1][0];
  return (words[0] ?? email).slice(0, 2);
};

// '14 Oct 2026', in Malaysia time.
const joinedDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

// ── Tab bodies ──────────────────────────────────────────────────────────────
// One component per tab, following routes/deliveries/page.tsx: an inactive
// tab's queries never fire — the payout details, the credit-ledger page and the
// vaulted-pull page are three requests the operator doesn't pay for until they
// ask for them.
//
// The trade is that a tab body's OWN state resets when the tab unmounts (a
// table offset, an unsaved bank draft — verified, not assumed). State that has
// to outlive a tab switch is therefore held by the parent instead: the modal,
// and History's table offset. Nothing here is destructive on reset — the bank
// form only ever writes on an explicit Save.
//
// Each tab body returns its OWN top-level Container(s), not a wrapper <div>:
// the page root is a `flex flex-col gap-y-3`, so a wrapper would swallow the
// gap between a tab's sections (Profile has several).
//
// History is the exception that keeps its queries in the PARENT. The header's
// frozen badge and its Freeze/Unfreeze button read `account_state` off the
// very same /audit response, so that query cannot move down there.

const Customer360Page = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const customerId = id || null;

  // The open tab lives in the URL, so a refresh, a shared link and the browser's
  // Back from another player all land on the same tab. `replace`: switching tabs
  // is not a step Back should walk through.
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: TabKey = TABS.find((k) => k === asked) ?? 'overview';
  const setTab = (next: TabKey) =>
    setParams(next === 'overview' ? {} : { tab: next }, { replace: true });

  // Offset page for the audit table (the endpoint serves 50/page).
  const [auditPage, setAuditPage] = useState(0);
  // Reset the offset when the viewed customer changes without a remount, so a
  // stale offset can't leak into the next customer's table. Render-phase reset
  // runs before the fetch — no wasted (newId, stalePage) request — and is a
  // harmless no-op if the route does remount.
  const [prevId, setPrevId] = useState(customerId);
  if (customerId !== prevId) {
    setPrevId(customerId);
    setAuditPage(0);
  }

  const { data: view, isError: viewError } = useCustomerGacha(customerId);
  // Name for the header; the Profile tab reads the same cached query.
  const { data: detail } = useCustomerDetail(customerId);
  const moneyQ = useCustomerMoney(customerId);
  const money = moneyQ.data;
  const auditQ = useCustomerAudit(customerId, auditPage);

  const freeze = useFreezeCustomer();
  const unfreeze = useUnfreezeCustomer();
  const adjustCredits = useAdjustCredits();
  // Every write on this page asks customer:update (api/admin-rbac.ts). A
  // view-only role sees the whole player and no button that would 403.
  const canEdit = usePermissions().hasPermission(
    'customer:update' as Permission,
  );

  // The header's badge and its Freeze/Unfreeze button read the account state
  // off the audit response — which is why that query stays here and not in the
  // History tab body (see the tab-body note above).
  const isFrozen = auditQ.data?.account_state?.frozen ?? false;
  // frozen (funds) and disabled (login) are orthogonal — badge them separately
  // off the same account_state, or a disabled player reads as a normal one.
  const isDisabled = auditQ.data?.account_state?.disabled ?? false;
  // Partner badge in the header (spec 2026-09-09). Shares the ReferralCard's
  // query key, so the card's own fetch answers this for free.
  const referralQ = useCustomerReferral(id ?? '');
  const playerName = [detail?.customer.first_name, detail?.customer.last_name]
    .filter(Boolean)
    .join(' ');

  // ── Modal state ─────────────────────────────────────────────────────────────
  const [modal, setModal] = useState<ModalKind | null>(null);
  // shared reason field (freeze / unfreeze)
  const [reason, setReason] = useState('');
  // credits-specific fields
  const [creditAmount, setCreditAmount] = useState('');
  const [creditNote, setCreditNote] = useState('');

  function openModal(kind: ModalKind) {
    setReason('');
    setCreditAmount('');
    setCreditNote('');
    setModal(kind);
  }
  function closeModal() {
    setModal(null);
  }

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

  // ── Prompt titles / descriptions per modal kind ──────────────────────────
  const MODAL_TITLE: Record<ModalKind, string> = {
    freeze: t('customer360.modalFreezeTitle'),
    unfreeze: t('customer360.modalUnfreezeTitle'),
    credits: t('customer360.modalCreditsTitle'),
  };

  const MODAL_DESC: Record<ModalKind, string> = {
    freeze: t('customer360.modalFreezeDesc'),
    unfreeze: t('customer360.modalUnfreezeDesc'),
    credits: t('customer360.modalCreditsDesc'),
  };

  function handleConfirm() {
    if (modal === 'freeze') applyFreeze();
    else if (modal === 'unfreeze') applyUnfreeze();
    else if (modal === 'credits') applyAdjustCredits();
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
    <div className="pc-dashboard flex flex-col gap-y-3">
      {/* ── Header: who, their account state, the actions, and the four
          numbers staff check first. ───────────────────────────────── */}
      <Container className="pc-settle p-0">
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <IconButton
              size="small"
              variant="transparent"
              aria-label={t('customer360.back')}
              onClick={() => navigate(-1)}
            >
              <ArrowLeft />
            </IconButton>
            <span
              aria-hidden
              className="bg-ui-bg-component text-ui-fg-subtle txt-compact-small-plus flex size-10 shrink-0 items-center justify-center rounded-full uppercase"
            >
              {initials(playerName, view?.customer.email ?? id)}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Heading level="h2" className="truncate">
                  {playerName || view?.customer.email || id}
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
                {isDisabled && (
                  <Badge size="small" color="red">
                    {t('players.disabled')}
                  </Badge>
                )}
                {/* Partner account (spec 2026-09-09) — from the referral card's
                    query, which the Profile tab also reads; the header shows it
                    whatever tab is open. Names the group when the group is the
                    source, since that is where it has to be changed. */}
                {referralQ.data?.partner_group ? (
                  <Badge size="small" color="purple">
                    {t('players.partnerViaGroup', {
                      group: referralQ.data.partner_group.name,
                    })}
                  </Badge>
                ) : referralQ.data?.partner_referral_bp !== null &&
                  referralQ.data?.partner_referral_bp !== undefined ? (
                  <Badge size="small" color="purple">
                    {t('players.partner')}
                  </Badge>
                ) : null}
              </div>
              {view && (
                <Text
                  size="small"
                  className="text-ui-fg-subtle mt-0.5 break-words"
                >
                  {[
                    playerName ? view.customer.email : null,
                    t('playerMoney.joined', {
                      date: joinedDate(view.customer.created_at),
                    }),
                    money?.last.open_at
                      ? t('playerMoney.activeAgo', {
                          ago: timeAgo(money.last.open_at),
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              )}
              {viewError && (
                <Text size="small" className="text-ui-fg-error mt-1">
                  {t('playerDetail.loadError')}
                </Text>
              )}
            </div>
          </div>
          {view && canEdit && (
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

        <MoneySummary money={money} view={view} />
      </Container>

      {/* ── Prompt modal — single instance, content varies by modal kind ─── */}
      <Prompt
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open) closeModal();
        }}
      >
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>{modal ? MODAL_TITLE[modal] : ''}</Prompt.Title>
            <Prompt.Description>
              {modal ? MODAL_DESC[modal] : ''}
            </Prompt.Description>
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

      {/* ── Tabs: stuck to the top, so the sections stay one click away however
          far down a long ledger the operator has scrolled. ─────────── */}
      {/* No z-index: Medusa's drawers and prompts have none, and any here would
          paint this bar over them. */}
      <Container className="sticky top-0 p-0">
        <div className="overflow-x-auto px-6 py-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
            <Tabs.List
              aria-label="Player detail sections"
              className="whitespace-nowrap"
            >
              <Tabs.Trigger value="overview">
                {t('playerDetail.tabOverview')}
              </Tabs.Trigger>
              <Tabs.Trigger value="wallet">
                {t('players.tabWallet')}
              </Tabs.Trigger>
              <Tabs.Trigger value="payments">
                {t('players.tabPayments')}
              </Tabs.Trigger>
              <Tabs.Trigger value="vault">{t('players.tabVault')}</Tabs.Trigger>
              <Tabs.Trigger value="orders">
                {t('players.tabOrders')}
              </Tabs.Trigger>
              <Tabs.Trigger value="pulls">{t('players.tabPulls')}</Tabs.Trigger>
              <Tabs.Trigger value="gifts">
                {t('playerMoney.tabGifts')}
              </Tabs.Trigger>
              <Tabs.Trigger value="lvl">{t('players.tabLvl')}</Tabs.Trigger>
              <Tabs.Trigger value="profile">
                {t('players.tabProfile')}
              </Tabs.Trigger>
              <Tabs.Trigger value="history">
                {t('players.tabHistory')}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </div>
      </Container>

      {tab === 'overview' &&
        (moneyQ.isError ? (
          <Container>
            <Text size="small" className="text-ui-fg-error">
              {t('playerMoney.loadError')}
            </Text>
          </Container>
        ) : !money ? (
          <Container>
            <LoadingSkeleton />
          </Container>
        ) : (
          <>
            <PeriodsCard money={money} />
            <PlayCard money={money} />
          </>
        ))}
      {/* key={id}: the tree's "open subtree" button navigates to another
          /customers/:id WITHOUT remounting this route, so without a key a tab
          body would keep the previous player's table offset and — worse — the
          previous player's bank-form draft. */}
      {tab === 'profile' && customerId && (
        <ProfileTab key={id} customerId={customerId} />
      )}
      {tab === 'lvl' && customerId && (
        <LevelTab key={id} customerId={customerId} />
      )}
      {tab === 'wallet' && customerId && (
        <WalletTab key={id} customerId={customerId} />
      )}
      {tab === 'payments' && customerId && (
        <PaymentsTab key={id} customerId={customerId} />
      )}
      {tab === 'vault' && customerId && (
        <VaultTab key={id} customerId={customerId} />
      )}
      {/* key={id} is what makes their keepPreviousData safe: the body remounts
          on a customer change, so there is no previous player's page to hold
          over. */}
      {tab === 'orders' && customerId && (
        <OrdersTab key={id} customerId={customerId} />
      )}
      {tab === 'pulls' && customerId && (
        <PullsTab key={id} customerId={customerId} />
      )}
      {/* key={id}: an unsent note must not carry over to the next player. */}
      {tab === 'gifts' && customerId && (
        <>
          <GiftAndBonusPanels key={id} customerId={customerId} />
          <LuckyDrawTicketsPanel
            key={`tickets-${id}`}
            customerId={customerId}
          />
        </>
      )}
      {tab === 'history' && (
        <HistoryTab
          auditQ={auditQ}
          auditPage={auditPage}
          setAuditPage={setAuditPage}
        />
      )}
    </div>
  );
};

export default Customer360Page;
