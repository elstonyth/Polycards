import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { toast } from '@medusajs/ui';
import { useTranslation } from 'react-i18next';
import {
  packsApi,
  type AdminCard,
  type AdminCardRegister,
  type AdminCardUpdate,
  type AdminPack,
  type AdminPackWrite,
  type LosslessSchedule,
  type LosslessScheduleWrite,
  type PackOddsResponse,
  type PullsResponse,
} from './packs-api';
import {
  adjustCustomerCredits,
  bulkUpdateDeliveryOrders,
  checkDeliveryTracking,
  createProductFromPriceCharting,
  deleteCard,
  deletePack,
  freezeCustomer,
  getAvatarFrames,
  getChallengeSettings,
  getChallengeStages,
  getChallengeSchedules,
  getChallengeWinners,
  createChallengeSchedule,
  updateChallengeSchedule,
  deleteChallengeSchedule,
  getCustomerAudit,
  getCustomerGacha,
  getCustomerTransactions,
  getCustomerPulls,
  getCustomerPackGifts,
  grantPackGifts,
  revokePackGift,
  type PackGift,
  getDeliveryOrder,
  getProfitReport,
  type CustomerScope,
  type ProfitRange,
  type ProfitReport,
  getStatsReport,
  getOnlineNow,
  getLeaders,
  type StatsRange,
  type StatsReport,
  type OnlineNow,
  type LeadersReport,
  getSettlementReport,
  getGatewayBalance,
  getGatewayAudit,
  acknowledgeAuditFinding,
  getPaymentGateway,
  savePaymentGateway,
  getWithdrawalControls,
  saveWithdrawalControls,
  type WithdrawalControlsView,
  gatewayPreflightRefusal,
  type SettlementGranularity,
  type SettlementReport,
  type GatewayBalance,
  type GatewayAudit,
  type PaymentGatewaySetting,
  getFxHistory,
  getFxRate,
  getPricingHealth,
  type PricingHealth,
  getPulls,
  getGatewayDeposits,
  type GatewayDepositView,
  type GatewayDepositsResponse,
  getGatewayWithdrawals,
  type GatewayWithdrawalView,
  type GatewayWithdrawalsResponse,
  approveWithdrawal,
  denyWithdrawal,
  getPixelPokemon,
  createPixelPokemon,
  type PixelPokemonPage,
  type PixelPokemonQuery,
  type CreatePixelPokemonBody,
  getVoucherLadder,
  getRewardsSettings,
  getSiteSettings,
  getTierSettings,
  getVipLevels,
  listDeliveryOrders,
  listEligibleProducts,
  saveAvatarFrames,
  saveChallengeSettings,
  saveChallengeStages,
  saveRewardsSettings,
  saveSiteSettings,
  saveTierSettings,
  saveVipLevels,
  saveVoucherRanges,
  setFxRate,
  unfreezeCustomer,
  updateDeliveryOrder,
  uploadImage,
  type AdminDeliveryOrder,
  type AvatarFramesView,
  type ChallengeSettingsDTO,
  type ChallengeStageDTO,
  type ChallengeScheduleDTO,
  type ChallengeWeekSummaryDTO,
  type ChallengeWinnerDTO,
  type CustomerAudit,
  type CustomerGacha,
  type SupportTransaction,
  type SupportPull,
  type DeliveryOrdersPage,
  type DeliveryStatus,
  type EligibleProduct,
  type FxChange,
  type FxRateState,
  type RewardsSettingsView,
  type SiteSettingsView,
  type TierRangeDTO,
  type TierSettingsDTO,
  type VipLevelDTO,
  type VoucherLadderDTO,
  type VoucherRangeDTO,
  // ── Epic 3 (Odds) ──
  listCustomerGroupsAdmin,
  setGroupOddsSet,
  setGroupPolicy,
  createCustomerGroupAdmin,
  countCustomersInGroup,
  setCustomerGroup,
  type AdminCustomerGroup,
  // ── Referral rebuild (spec 2026-08-24) ──
  getReferralSettings,
  updateReferralSettings,
  listReferralSettlements,
  getReferralSettlement,
  approveReferralSettlement,
  payReferralSettlement,
  voidReferralLine,
  getCustomerReferral,
  listTaskDefinitions,
  saveTaskDefinition,
  type AdminTaskDefinition,
  listLuckyDraw,
  saveLuckyDrawEvent,
  publishLuckyDrawEvent,
  withdrawLuckyDrawEvent,
  saveLuckyDrawPrize,
  cancelLuckyDrawPrize,
  listLuckyDrawEntries,
  listLuckyDrawEventEntrants,
  getLuckyDrawTickets,
  adjustCustomerTickets,
  getTicketPrizes,
  saveTicketPrizes,
  type AdminTicketPrizeEntry,
  type AdminLuckyDrawEvent,
  listAnnouncements,
  saveAnnouncement,
  deleteAnnouncement,
  type AdminAnnouncement,
  setCustomerReferrer,
  setPartnerRate,
  setCustomerRealName,
  setCustomerPhone,
  voidReferralSettlement,
  type CustomerReferralCard,
  type ReferralSettings,
  type ReferralSettlement,
  type ReferralSettlementLine,
  type ReferralTierWire,
} from './admin-rest';
import type { SetEntry } from '@acme/odds-math';
import type { GroupPolicy } from './player-groups';
import { qk } from './query-keys';
import { keepPreviousWhenSame } from './keep-previous';
import { LEDGER_CURRENCY } from './format';
import {
  classifyApproveResult,
  classifyDenyResult,
} from './withdrawal-outcome';

// ── Display queries ──────────────────────────────────────────────────────────

// `enabled` matters more than usual here: the packs list now fans out to every
// odds + card row to compute EV/RTP, so callers that only need the pack NAMES
// (the cards page's bulk "add to pack" picker) must not pay for it on mount.
export const usePacks = (
  opts: { enabled?: boolean } = {},
): UseQueryResult<AdminPack[]> =>
  useQuery({
    queryKey: qk.packs,
    queryFn: () => packsApi.admin.packs.query().then((r) => r.packs),
    enabled: opts.enabled ?? true,
  });

// `enabled` lets the pack odds editor's pool picker share this exact cache while
// only fetching when its modal is open.
export const useCards = (
  opts: { enabled?: boolean } = {},
): UseQueryResult<AdminCard[]> =>
  useQuery({
    queryKey: qk.cards,
    queryFn: () => packsApi.admin.cards.query().then((r) => r.cards),
    enabled: opts.enabled ?? true,
  });

export const usePricingHealth = (): UseQueryResult<PricingHealth> =>
  useQuery({
    queryKey: qk.pricingHealth,
    queryFn: getPricingHealth,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

// `customerId` scopes the ledger to one player (the player-detail tabs). Blank
// is OMITTED by getPulls, never sent as an empty param — the route 400s on one.
export const usePulls = (
  page = 0,
  source?: 'pack' | 'reward',
  customerId?: string,
): UseQueryResult<PullsResponse> =>
  useQuery({
    queryKey: qk.pulls(page, source, customerId),
    queryFn: () => getPulls(page, 50, source, customerId),
    placeholderData: keepPreviousData,
  });

// Pixel-Pokémon library (Pokédex). Keyed on the full query so search/filter/page
// changes refetch; keepPreviousData avoids a flash while typing.
export const usePixelPokemon = (
  params: PixelPokemonQuery,
  opts: { enabled?: boolean } = {},
): UseQueryResult<PixelPokemonPage> =>
  useQuery({
    queryKey: ['pixel-pokemon', params],
    queryFn: () => getPixelPokemon(params),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });

// Add a custom pixel-pokémon; refetches the library grid on success.
export const useCreatePixelPokemon = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePixelPokemonBody) => createPixelPokemon(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pixel-pokemon'] });
      toast.success('Pixel Pokémon added.');
    },
    onError: (e: Error) => toast.error(e.message),
  });
};

/** Money moved, or a player changed group (which moves them in or out of
 *  "real customers"): the Profit report and the Dashboard's figures are
 *  stale. Marks every cached view; only mounted ones refetch. */
export const invalidateMoneyViews = (qc: QueryClient) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: qk.profitReportKey }),
    qc.invalidateQueries({ queryKey: ['admin', 'stats'] }),
    qc.invalidateQueries({ queryKey: ['admin', 'gateway-settlement'] }),
    // Every player's money card (qk.customerMoney), whichever player moved.
    qc.invalidateQueries({
      predicate: (q) =>
        q.queryKey[0] === 'admin' &&
        q.queryKey[1] === 'customer' &&
        q.queryKey[3] === 'money',
    }),
  ]);

// Profit report. keepPreviousData so a period or scope switch swaps the
// numbers without a skeleton flash; a half-picked custom range never fires.
export const useProfitReport = (
  range: ProfitRange,
  from: string,
  to: string,
  scope: CustomerScope,
): UseQueryResult<ProfitReport> =>
  useQuery({
    queryKey: qk.profitReport(
      range,
      range === 'custom' ? from : '',
      range === 'custom' ? to : '',
      scope,
    ),
    queryFn: () => getProfitReport(range, from, to, scope),
    placeholderData: keepPreviousData,
    enabled: range !== 'custom' || (from !== '' && to !== '' && from <= to),
    refetchOnWindowFocus: true,
  });

// Stats page. keepPreviousData so switching presets swaps the numbers without
// a skeleton flash (the economy precedent). The page passes '' for the dates
// unless the range is 'custom'; a half-picked or reversed custom range never
// fires (it could only 400), the page shows a hint instead.
export const useStats = (
  range: StatsRange,
  from: string,
  to: string,
  scope: CustomerScope = 'all',
): UseQueryResult<StatsReport> =>
  useQuery({
    queryKey: qk.stats(range, from, to, scope),
    queryFn: () => getStatsReport(range, from, to, scope),
    placeholderData: keepPreviousData,
    enabled: range !== 'custom' || (from !== '' && to !== '' && from <= to),
    // The dashboard's QueryClient disables focus refetch; "today" is live,
    // so coming back to the tab should show fresh numbers.
    refetchOnWindowFocus: true,
  });

// The Dashboard's "online now". No keepPreviousData: a scope switch shows
// "…" rather than the other scope's count.
export const useOnlineNow = (
  scope: CustomerScope = 'all',
): UseQueryResult<OnlineNow> =>
  useQuery({
    queryKey: qk.statsOnline(scope),
    queryFn: () => getOnlineNow(scope),
    refetchOnWindowFocus: true,
  });

// The All Players page's top players for one window.
export const useLeaders = (
  range: StatsRange,
  scope: CustomerScope = 'all',
): UseQueryResult<LeadersReport> =>
  useQuery({
    queryKey: qk.statsLeaders(range, scope),
    queryFn: () => getLeaders(range, scope),
    refetchOnWindowFocus: true,
  });

// Calendar weekly/monthly gateway settlement report. keepPreviousData so the
// week/month toggle swaps without a skeleton flash (the economy precedent).
export const useSettlementReport = (
  granularity: SettlementGranularity,
  periods: number,
  currency: string,
  scope: CustomerScope = 'all',
): UseQueryResult<SettlementReport> =>
  useQuery({
    queryKey: qk.settlement(granularity, periods, currency, scope),
    queryFn: () => getSettlementReport(granularity, periods, currency, scope),
    placeholderData: keepPreviousData,
  });

// Live merchant balance at the gateway. A real upstream call (20s worst case),
// so it refetches on a slow interval rather than every focus — the number
// moves with settlements, not with tab switches.
export const useGatewayBalance = (
  currency: string,
): UseQueryResult<GatewayBalance> =>
  useQuery({
    queryKey: qk.gatewayBalance(currency),
    queryFn: () => getGatewayBalance(currency),
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

export const useGatewayAudit = (
  currency: string,
): UseQueryResult<GatewayAudit> =>
  useQuery({
    queryKey: qk.gatewayAudit(currency),
    queryFn: () => getGatewayAudit(currency),
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

export const usePaymentGateway = (): UseQueryResult<PaymentGatewaySetting> =>
  useQuery({ queryKey: qk.paymentGateway, queryFn: getPaymentGateway });

export const useWithdrawalControls =
  (): UseQueryResult<WithdrawalControlsView> =>
    useQuery({
      queryKey: qk.withdrawalControls,
      queryFn: getWithdrawalControls,
      // The status line ("closed until 6:00 AM") follows the clock.
      refetchInterval: 60_000,
    });

export const useSaveWithdrawalControls = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveWithdrawalControls,
    onSuccess: (data) => {
      toast.success('Withdrawal controls saved');
      qc.setQueryData(qk.withdrawalControls, data);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// Settlement's Acknowledge. Refetches every rail's audit: the Dashboard's
// "may be paid twice" row reads them too.
export const useAcknowledgeFinding = () => {
  const qc = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: acknowledgeAuditFinding,
    onSuccess: () => toast.success(t('settlement.acknowledgedToast')),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
    // Also after a refusal: a 409 means the note changed, so show the new one.
    onSettled: () =>
      qc.invalidateQueries({ queryKey: ['admin', 'gateway-audit'] }),
  });
};

export const useSavePaymentGateway = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: savePaymentGateway,
    onSuccess: (data) => {
      toast.success('Payment gateway switched');
      for (const warning of data.warnings ?? []) toast.warning(warning);
      qc.invalidateQueries({ queryKey: qk.paymentGateway });
      // The switch picks the RM rail's gateway; the regional tabs are not
      // affected.
      qc.invalidateQueries({ queryKey: qk.gatewayBalance(LEDGER_CURRENCY) });
      qc.invalidateQueries({ queryKey: qk.gatewayAudit(LEDGER_CURRENCY) });
    },
    onError: (e) => {
      // A live-check refusal is answered by the page's "Switch anyway"
      // dialog, which lists the problems — no toast on top of it.
      if (gatewayPreflightRefusal(e)) return;
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });
};

export const usePackOdds = (slug: string): UseQueryResult<PackOddsResponse> =>
  useQuery({
    queryKey: qk.packOdds(slug),
    queryFn: () => packsApi.admin.packs.$slug.odds.query({ $slug: slug }),
    enabled: !!slug,
  });

// staleTime 0: the picker must reflect a card registered moments ago, so each
// modal-open refetches rather than serving the 90s-stale dashboard default.
export const useEligibleProducts = (
  enabled: boolean,
): UseQueryResult<EligibleProduct[]> =>
  useQuery({
    queryKey: qk.eligibleProducts,
    queryFn: listEligibleProducts,
    enabled,
    staleTime: 0,
  });

export const useCustomerGacha = (
  id: string | null,
): UseQueryResult<CustomerGacha> =>
  useQuery({
    queryKey: qk.customerGacha(id ?? ''),
    queryFn: () => getCustomerGacha(id as string),
    enabled: !!id,
  });

export const useCustomerAudit = (
  id: string | null,
  page = 0,
): UseQueryResult<CustomerAudit> =>
  useQuery({
    queryKey: qk.customerAudit(id ?? '', page),
    queryFn: () => getCustomerAudit(id!, page),
    enabled: !!id,
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === (id ?? '') ? prev : undefined,
  });

export const useCustomerTransactions = (
  id: string | null,
  page = 0,
  reasons?: readonly string[] | null,
): UseQueryResult<{ items: SupportTransaction[]; total: number }> => {
  const queryKey = qk.customerTransactions(
    id ?? '',
    page,
    reasons?.length ? reasons.join(',') : 'all',
  );
  return useQuery({
    queryKey,
    queryFn: () => getCustomerTransactions(id!, page, 25, reasons ?? undefined),
    enabled: !!id,
    // Page turns only: a filter change shows a skeleton, never the old
    // filter's rows under the new one.
    placeholderData: keepPreviousWhenSame(queryKey, 5),
  });
};

// `opts` narrows the history server-side and is part of the cache key, so the
// Vault tab's vaulted-only view and the support page's full history are
// separate entries instead of overwriting each other for the same (id, page).
export const useCustomerPulls = (
  id: string | null,
  page = 0,
  // status only — getCustomerPulls also accepts `source`, but nothing needs it
  // here and an un-keyed filter would collide in the cache.
  opts?: { status?: string; sort?: 'newest' | 'value' },
): UseQueryResult<{
  items: SupportPull[];
  total: number;
  fx?: { rate: number; firm: boolean };
}> => {
  const queryKey = qk.customerPulls(id ?? '', page, opts?.status, opts?.sort);
  return useQuery({
    queryKey,
    queryFn: () => getCustomerPulls(id!, page, 25, opts),
    enabled: !!id,
    // Page turns only: a status or sort change shows a skeleton instead.
    placeholderData: keepPreviousWhenSame(queryKey, 5),
  });
};

// `customerId` scopes the table to one player. listDeliveryOrders takes `limit`
// BEFORE it (4th arg), so the default 50 is passed explicitly here.
export const useDeliveryOrders = (
  status?: DeliveryStatus,
  page = 0,
  q?: string,
  customerId?: string,
  sort?: string,
): UseQueryResult<DeliveryOrdersPage> =>
  useQuery({
    queryKey: qk.deliveryOrders(status, page, q, customerId, sort),
    queryFn: () => listDeliveryOrders(status, page, q, 50, customerId, sort),
    placeholderData: keepPreviousData,
  });

// One order by id. The packing-slip view mounts one of these per selected id so
// a stale/deleted id fails inside its own block instead of blanking the sheet.
export const useDeliveryOrder = (
  id: string,
): UseQueryResult<AdminDeliveryOrder> =>
  useQuery({
    queryKey: qk.deliveryOrder(id),
    queryFn: () => getDeliveryOrder(id),
    enabled: !!id,
  });

export const useFxRate = (): UseQueryResult<FxRateState> =>
  useQuery({ queryKey: qk.fxRate, queryFn: getFxRate });

export const useFxHistory = (): UseQueryResult<{ changes: FxChange[] }> =>
  useQuery({ queryKey: qk.fxHistory, queryFn: getFxHistory });

// ── Mutations ────────────────────────────────────────────────────────────────

export const useUpdateCard = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { handle: string } & AdminCardUpdate) => {
      const { handle, ...payload } = vars;
      return packsApi.admin.cards.$handle.mutate({
        $handle: handle,
        ...payload,
      });
    },
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.cards }),
        qc.invalidateQueries({ queryKey: qk.pricingHealth }),
      ]),
  });
};

export const useDeleteCard = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) => deleteCard(handle),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.cards }),
        qc.invalidateQueries({ queryKey: qk.pricingHealth }),
      ]),
  });
};

export const useRegisterCard = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AdminCardRegister) =>
      packsApi.admin.cards.mutate(payload),
    onSuccess: () => {
      // The product is no longer eligible once registered, and the card list grew.
      qc.invalidateQueries({ queryKey: qk.cards });
      qc.invalidateQueries({ queryKey: qk.pricingHealth });
      // MARK STALE, DO NOT REFETCH. invalidateQueries defaults to
      // refetchType:'active', and the Inventory list's bulk tool keeps
      // useEligibleProducts(selected.size > 0) ACTIVE for the whole run — so an
      // N-row run fired up to N refetches of /admin/gacha/eligible-products,
      // which reads 1000 products + 1000 cards each time. (The loop itself is
      // unaffected: it registers from a map closed over at click time, so a
      // mid-loop refetch could never have changed its behaviour.)
      //
      // Safe for all THREE consumers, by two different mechanisms. Two are
      // enabled-gated, and this query is staleTime:0, so they refetch the
      // moment they are switched back on — the register modal's picker on the
      // next open (enabled:false while closed), and the Inventory bulk tool's
      // map on the next selection, which is guaranteed to be a re-enable
      // because routes/inventory/list/page.tsx clears `selected`
      // unconditionally at the end of every run (see the comment on that line).
      // The third, purchase-invoices/new/page.tsx, calls
      // useEligibleProducts(true) — PERMANENTLY enabled, so the gate argument
      // does not cover it. It is safe for a different reason: it is a route
      // page, so it cannot be mounted while this mutation fires, which leaves
      // its query INACTIVE at invalidation time (the old refetchType:'active'
      // default skipped it too — zero behaviour change), and it refetches on
      // mount anyway via shouldFetchOnMount -> isStale at staleTime:0.
      qc.invalidateQueries({
        queryKey: qk.eligibleProducts,
        refetchType: 'none',
      });
    },
  });
};

export const useSetFxRate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: setFxRate,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.fxRate });
      qc.invalidateQueries({ queryKey: qk.cards });
      qc.invalidateQueries({ queryKey: qk.fxHistory });
      toast.success('Exchange rate updated');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useCreatePack = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string } & AdminPackWrite) =>
      packsApi.admin.packs.mutate(vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.packs }),
  });
};

export const useUpdatePack = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string } & AdminPackWrite) => {
      const { slug, ...payload } = vars;
      // Fixed at creation. Callers spread a whole AdminPack in here, and the
      // route refuses to change it, so it never travels.
      delete payload.prize_type;
      return packsApi.admin.packs.$slug.mutate({ $slug: slug, ...payload });
    },
    // The pack's status also renders on its odds-editor page (activate /
    // set-to-draft lives there), so refresh that snapshot too.
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.packs });
      qc.invalidateQueries({ queryKey: qk.packOdds(vars.slug) });
    },
  });
};

// One request for the whole swap: the old per-pack Promise.all half-applied
// the reorder when a single row's update was rejected (active pack, empty
// pool), leaving the list order corrupted until reload.
export const useReorderPacks = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { order: { slug: string; rank: number }[] }) =>
      packsApi.admin.packs.reorder.mutate(vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.packs }),
  });
};

export const useDeletePack = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => deletePack(slug),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.packs }),
  });
};

// Lossless Mode windows (newest start first, max 100). Windows are priced
// server-side, so the only client duty is to keep this list fresh after a write.
export const useLosslessSchedules = (): UseQueryResult<LosslessSchedule[]> =>
  useQuery({
    queryKey: qk.losslessSchedules,
    queryFn: () =>
      packsApi.admin['lossless-schedules'].query().then((r) => r.schedules),
  });

export const useCreateLosslessSchedule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: LosslessScheduleWrite) =>
      packsApi.admin['lossless-schedules'].mutate(vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.losslessSchedules }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useCancelLosslessSchedule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      packsApi.admin['lossless-schedules'].$id.cancel.mutate({
        $id: vars.id,
        reason: vars.reason,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.losslessSchedules }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// No invalidation by design: the editor patches its local rows from the response
// (the server is authoritative for the computed %), keeping the lock-save path
// identical to the pre-refactor behavior. See the design spec.
export const useSaveOdds = () =>
  useMutation({
    mutationFn: (vars: {
      slug: string;
      entries: SetEntry[];
      /** Basis points; omit to leave the pack's stored target unchanged. */
      target_rtp_bps?: number;
    }) =>
      packsApi.admin.packs.$slug.odds.mutate({
        $slug: vars.slug,
        entries: vars.entries,
        target_rtp_bps: vars.target_rtp_bps,
      }),
  });

export const useTicketPrizes = (slug: string) =>
  useQuery({
    queryKey: qk.ticketPrizes(slug),
    queryFn: () => getTicketPrizes(slug),
    enabled: !!slug,
  });

export const useSaveTicketPrizes = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string; rows: AdminTicketPrizeEntry[] }) =>
      saveTicketPrizes(vars.slug, vars.rows),
    // A save can add or remove rows, so the editor reseeds. Returned so
    // mutateAsync resolves only after the refetch.
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: qk.ticketPrizes(vars.slug) }),
  });
};

export const useSaveMembers = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string; card_ids: string[] }) =>
      packsApi.admin.packs.$slug.members.mutate({
        $slug: vars.slug,
        card_ids: vars.card_ids,
      }),
    // Membership changed → reload the odds snapshot (the editor reseeds its rows).
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: qk.packOdds(vars.slug) }),
  });
};

export const useSaveTopHits = () =>
  useMutation({
    mutationFn: (vars: { slug: string; card_ids: string[] }) =>
      packsApi.admin.packs.$slug['top-hits'].mutate({
        $slug: vars.slug,
        card_ids: vars.card_ids,
      }),
    // NO invalidation on purpose: the editor updates its buffer optimistically
    // and a refetch would reseed the rows, clobbering in-progress win-rate
    // edits. Flags are the only change, so local state == server state.
  });

// kind 'bonus' = the Bonus credit panel. The idempotency key is minted by the
// caller per confirmed submit, never here: a retry of mutationFn would mint a
// second key and apply twice.
export const useAdjustCredits = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      amount: number;
      note: string;
      idempotencyKey?: string;
      kind?: 'bonus';
    }) =>
      adjustCustomerCredits(
        vars.id,
        vars.amount,
        vars.note,
        vars.idempotencyKey,
        vars.kind,
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.customerGacha(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerTransactionsKey(vars.id) });
      // The Players list shows the wallet column this just moved.
      qc.invalidateQueries({ queryKey: qk.playersKey });
      void invalidateMoneyViews(qc);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useCustomerPackGifts = (id: string): UseQueryResult<PackGift[]> =>
  useQuery({
    queryKey: qk.customerPackGifts(id),
    queryFn: () => getCustomerPackGifts(id).then((r) => r.gifts),
    enabled: !!id,
  });

export const useGrantPackGifts = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      pack_id: string;
      quantity: number;
      note: string;
      idempotency_key: string;
    }) => {
      const { id, ...body } = vars;
      return grantPackGifts(id, body);
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.customerPackGifts(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerGacha(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.id) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useRevokePackGift = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { giftId: string; customerId: string }) =>
      revokePackGift(vars.giftId),
    // onSettled, not onSuccess: a 409 "Already opened" means the row moved
    // under us, so the table must re-read either way.
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: qk.customerPackGifts(vars.customerId) });
      qc.invalidateQueries({ queryKey: qk.customerGacha(vars.customerId) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.customerId) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useFreezeCustomer = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      freezeCustomer(vars.id, vars.reason),
    onSuccess: (_data, vars) => {
      toast.success('Customer frozen');
      qc.invalidateQueries({ queryKey: qk.customerGacha(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.id) });
      // Frozen = nothing can be withdrawn: the Wallet tab's figure moves.
      qc.invalidateQueries({ queryKey: qk.customerMoney(vars.id) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useUnfreezeCustomer = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      unfreezeCustomer(vars.id, vars.reason),
    onSuccess: (_data, vars) => {
      toast.success('Customer unfrozen');
      qc.invalidateQueries({ queryKey: qk.customerGacha(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerMoney(vars.id) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useUploadImage = () =>
  useMutation({
    mutationFn: (vars: {
      file: File;
      kind:
        | 'pack'
        | 'display'
        | 'card'
        | 'sprite'
        | 'frame'
        | 'avatar-frame'
        | 'delivery'
        | 'announcement';
    }) => uploadImage(vars.file, vars.kind),
  });

export const useUpdateDeliveryOrder = () => {
  const invalidateStock = useInvalidateStock();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      status?: DeliveryStatus;
      tracking_number?: string | null;
      proof_images?: string[];
    }) =>
      updateDeliveryOrder(vars.id, {
        status: vars.status,
        tracking_number: vars.tracking_number,
        proof_images: vars.proof_images,
      }),
    // Status filters + pages vary, so drop the whole delivery-orders
    // namespace — and the Stock buckets and Procurement lists a status move
    // changes (useInvalidateStock covers all of them).
    onSuccess: () => invalidateStock(),
  });
};

export const useBulkUpdateDeliveryOrders = () => {
  const invalidateStock = useInvalidateStock();
  return useMutation({
    mutationFn: (vars: { ids: string[]; status: DeliveryStatus }) =>
      bulkUpdateDeliveryOrders(vars.ids, vars.status),
    // Partial success is the contract, so invalidate on SETTLE (not success):
    // a throw here can still leave earlier ids in the batch already moved.
    onSettled: () => invalidateStock(),
  });
};

// Completions flip stock (shipped cards leave the shelf count) the same way a
// bulk move does, so it invalidates the same keys.
export const useCheckDeliveryTracking = () => {
  const invalidateStock = useInvalidateStock();
  return useMutation({
    mutationFn: checkDeliveryTracking,
    onSettled: () => invalidateStock(),
  });
};

export type { VoucherLadderDTO, VoucherRangeDTO } from './admin-rest';

export const useVoucherLadder = (): UseQueryResult<VoucherLadderDTO> =>
  useQuery({ queryKey: qk.voucherLadder, queryFn: getVoucherLadder });

export const useSaveVoucherRanges = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { ranges: VoucherRangeDTO[]; reason: string }) =>
      saveVoucherRanges(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.voucherLadder });
      toast.success('Voucher ranges saved');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export type { RewardsSettingsView } from './admin-rest';

export const useRewardsSettings = (): UseQueryResult<RewardsSettingsView> =>
  useQuery({ queryKey: qk.rewardsSettings, queryFn: getRewardsSettings });

export const useSaveRewardsSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveRewardsSettings,
    onSuccess: () => {
      toast.success('Engine settings saved');
      qc.invalidateQueries({ queryKey: qk.rewardsSettings });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export type { SiteSettingsView } from './admin-rest';

export const useSiteSettings = (): UseQueryResult<SiteSettingsView> =>
  useQuery({ queryKey: qk.siteSettings, queryFn: getSiteSettings });

export const useSaveSiteSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveSiteSettings,
    onSuccess: () => {
      toast.success('Slab frame saved');
      qc.invalidateQueries({ queryKey: qk.siteSettings });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export type { AvatarFramesView } from './admin-rest';

export const useAvatarFrames = (): UseQueryResult<AvatarFramesView> =>
  useQuery({ queryKey: qk.avatarFrames, queryFn: getAvatarFrames });

export const useSaveAvatarFrames = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveAvatarFrames,
    onSuccess: () => {
      toast.success('Avatar frames saved');
      qc.invalidateQueries({ queryKey: qk.avatarFrames });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export type {
  VipLevelDTO,
  ChallengeStageDTO,
  ChallengeScheduleDTO,
  ChallengeWeekSummaryDTO,
  ChallengeWinnerDTO,
  ChallengeSettingsDTO,
} from './admin-rest';

export const useVipLevels = (): UseQueryResult<{ levels: VipLevelDTO[] }> =>
  useQuery({ queryKey: qk.vipLevels, queryFn: getVipLevels });

export const useSaveVipLevels = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { levels: VipLevelDTO[]; reason: string }) =>
      saveVipLevels(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.vipLevels });
      toast.success('VIP levels saved');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useChallengeStages = (): UseQueryResult<{
  stages: ChallengeStageDTO[];
}> => useQuery({ queryKey: qk.challengeStages, queryFn: getChallengeStages });

export const useSaveChallengeStages = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { stages: ChallengeStageDTO[]; reason: string }) =>
      saveChallengeStages(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.challengeStages });
      toast.success('Milestone stages saved');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useChallengeSchedules = (): UseQueryResult<{
  schedules: ChallengeScheduleDTO[];
}> =>
  useQuery({
    queryKey: qk.challengeSchedules,
    queryFn: getChallengeSchedules,
  });

// Both mutations invalidate the LIVE stages too: promotion rewrites them, so a
// queue change the operator makes right after a promotion must not leave a
// stale ladder on the Milestone Stages tab.
export const useCreateChallengeSchedule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      starts_at: string;
      label: string | null;
      stages: ChallengeStageDTO[];
      reason: string;
    }) => createChallengeSchedule(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.challengeSchedules });
      qc.invalidateQueries({ queryKey: qk.challengeStages });
      toast.success('Weekly challenge scheduled');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useUpdateChallengeSchedule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      starts_at: string;
      label: string | null;
      stages: ChallengeStageDTO[];
      reason: string;
    }) => updateChallengeSchedule(vars.id, vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.challengeSchedules });
      qc.invalidateQueries({ queryKey: qk.challengeStages });
      toast.success('Scheduled challenge updated');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useDeleteChallengeSchedule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteChallengeSchedule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.challengeSchedules });
      toast.success('Scheduled challenge removed');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// Keyed on the selected week so switching weeks does not blow the cache away,
// and '' (latest) is its own entry. Read-only history — no mutation hooks.
export const useChallengeWinners = (
  week: string,
): UseQueryResult<{
  weeks: ChallengeWeekSummaryDTO[];
  week: string | null;
  winners: ChallengeWinnerDTO[];
}> =>
  useQuery({
    queryKey: qk.challengeWinners(week),
    queryFn: () => getChallengeWinners(week || undefined),
  });

export const useChallengeSettings = (): UseQueryResult<ChallengeSettingsDTO> =>
  useQuery({ queryKey: qk.challengeSettings, queryFn: getChallengeSettings });

export const useSaveChallengeSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      patch: Partial<ChallengeSettingsDTO>;
      reason: string;
    }) => saveChallengeSettings(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.challengeSettings });
      toast.success('Week & payout saved');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// ── Tier defaults (price range per rarity tier) ──────────────────────────────

export const useTierSettings = (
  options: { enabled?: boolean } = {},
): UseQueryResult<TierSettingsDTO> =>
  useQuery({
    queryKey: qk.tierSettings,
    queryFn: getTierSettings,
    enabled: options.enabled ?? true,
  });

export const useSaveTierSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      ranges: Record<string, TierRangeDTO>;
      reason: string;
    }) => saveTierSettings(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.tierSettings });
      toast.success('Tier defaults saved');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// Gateway deposits. Polls once a minute: this is the money-in watch list, and a
// stranded payment should surface without an operator remembering to reload.
export const useGatewayDeposits = (
  page = 0,
  status: GatewayDepositView = 'pending',
  sort?: string,
): UseQueryResult<GatewayDepositsResponse> =>
  useQuery({
    queryKey: qk.gatewayDeposits(page, status, sort),
    queryFn: () => getGatewayDeposits(page, status, 50, sort),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

// Gateway withdrawals — same one-minute poll as deposits: this is the
// money-out watch list, and a debited-but-unpaid customer should surface
// without an operator remembering to reload.
export const useGatewayWithdrawals = (
  page = 0,
  // No default: the sole caller (routes/withdrawals/page.tsx) always passes
  // this explicitly, seeded from state initialized to 'held' (plan 094's
  // operator-facing default view). A `= 'pending'` default here was dead and
  // actively misleading — it contradicted that default without ever firing.
  status: GatewayWithdrawalView,
  sort?: string,
): UseQueryResult<GatewayWithdrawalsResponse> =>
  useQuery({
    queryKey: qk.gatewayWithdrawals(page, status, sort),
    queryFn: () => getGatewayWithdrawals(page, status, 50, sort),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

// One customer's gateway top-ups / payouts, every status, newest first — the
// player page's Payments tab ("is it still pending, rejected, paid out?").
export const useCustomerGatewayDeposits = (
  customerId: string,
  page = 0,
): UseQueryResult<GatewayDepositsResponse> =>
  useQuery({
    queryKey: qk.customerDeposits(customerId, page),
    queryFn: () => getGatewayDeposits(page, 'all', 20, undefined, customerId),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

export const useCustomerGatewayWithdrawals = (
  customerId: string,
  page = 0,
): UseQueryResult<GatewayWithdrawalsResponse> =>
  useQuery({
    queryKey: qk.customerWithdrawals(customerId, page),
    queryFn: () =>
      getGatewayWithdrawals(page, 'all', 20, undefined, customerId),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

// Claim a held withdrawal and submit it to the gateway. Three real outcomes
// (classifyApproveResult) get three different toasts — a plain "Approved!"
// on all of them would hide the two that need the operator's attention:
// - 'submitted': the normal path.
// - 'ambiguous': the gateway didn't confirm receipt; the row is left
//   'pending' for the reconcile sweep to resolve automatically.
// - 'already-handled': the idempotent no-op (a double-click, or another
//   admin's tab, already moved the row out of 'held'). Worded without
//   asserting a specific resulting status — the route's `status` field can be
//   stale here (see WithdrawalApproveResult's comment) — the
//   invalidate below is what shows the row's real current state.
//
// onSettled (not onSuccess) invalidates: a THROWN refusal can still have
// closed the row server-side (a definite gateway refusal or a never-debited
// row both refund-and-close before throwing — see approve/route.ts), so an
// unconditional refresh is the only branch that is never wrong. The whole
// withdrawals prefix, not just the current (page, status, sort): the row may
// now belong to a different view than the one on screen.
export const useApproveWithdrawal = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => approveWithdrawal(id),
    onSuccess: (data) => {
      switch (classifyApproveResult(data)) {
        case 'submitted':
          toast.success('Withdrawal approved', {
            description: `Submitted to the payment gateway (transaction ${data.transaction_id}).`,
          });
          break;
        case 'ambiguous':
          toast.warning('Submitted, outcome unconfirmed', {
            description:
              'The gateway did not confirm receipt. Left pending for the automatic reconcile job — check the Pending view shortly.',
          });
          break;
        case 'already-handled':
          toast.warning('No action taken', {
            description:
              'This withdrawal was already resolved — by an earlier click or another admin. The list has been refreshed.',
          });
          break;
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.gatewayWithdrawalsKey });
      void invalidateMoneyViews(qc);
    },
  });
};

// Claim a held (or already-'failed', for the crash-recovery re-run)
// withdrawal, refund it, and close it. Same onSettled-invalidate reasoning as
// approve above.
export const useDenyWithdrawal = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => denyWithdrawal(id),
    onSuccess: (data) => {
      switch (classifyDenyResult(data)) {
        case 'refunded':
          toast.success('Withdrawal denied', {
            description: "The debit was refunded to the customer's balance.",
          });
          break;
        case 'closed-no-refund':
          // The never-debited edge case (Task 5): closed, but there was
          // nothing to refund — worth flagging, not a silent success.
          toast.warning('Withdrawal closed — no refund issued', {
            description: 'No prior debit was found for this withdrawal.',
          });
          break;
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.gatewayWithdrawalsKey });
      void invalidateMoneyViews(qc);
    },
  });
};

// ── Epic 2 (Players) ─────────────────────────────────────────────────────────
// Own import block (not merged into the one at the top) so this whole section
// stays append-only while a parallel epic edits the same file.
import {
  createPlayers,
  disablePlayer,
  enablePlayer,
  exportPartnerAccountsXlsx,
  getCustomerDetail,
  getPayoutDetails,
  getSpendReport,
  getCustomerMoney,
  type CustomerMoney,
  listPlayers,
  savePayoutDetails,
  type AdminCustomerDetail,
  type PayoutDetails,
  type PlayersPage,
  type PlayersPeriod,
} from './admin-rest';

export type {
  CreatedPlayer,
  PlayerRow,
  PlayersPage,
  PayoutDetails,
} from './admin-rest';

// No success toast: the modal that calls this shows the credentials, which is
// the real confirmation. New rows land on page 0 of the list (newest first)
// and shift their group's member count.
export const useCreatePlayers = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createPlayers,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.playersKey });
      qc.invalidateQueries({ queryKey: qk.customerGroupCounts });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// The .xlsx of generated partner logins; `ids` narrows it to one batch. A
// mutation only for its pending flag and error toast — nothing is cached.
export const useExportPartnerAccounts = () =>
  useMutation({
    mutationFn: (ids?: string[]) => exportPartnerAccountsXlsx(ids),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

// Paged + searchable, but NOT id-scoped, so plain keepPreviousData is right
// here (no stale-row-click hazard — the whole page swaps together).
// A half-typed custom period (a day missing, or from after to) waits instead
// of asking: the route would 400, and the previous page stays on screen.
export const usePlayers = (
  page = 0,
  q?: string,
  sort?: string,
  group?: string,
  period?: PlayersPeriod,
): UseQueryResult<PlayersPage> =>
  useQuery({
    queryKey: qk.players(page, q, sort, group, period),
    queryFn: () => listPlayers(page, q, 50, sort, group, period),
    placeholderData: keepPreviousData,
    enabled:
      period?.range !== 'custom' ||
      (!!period.from && !!period.to && period.from <= period.to),
  });

// `disabled` is the TARGET state: true → block login, false → lift the block.
export const useSetPlayerDisabled = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; disabled: boolean; reason: string }) =>
      vars.disabled
        ? disablePlayer(vars.id, vars.reason)
        : enablePlayer(vars.id, vars.reason),
    onSuccess: (_data, vars) => {
      toast.success(vars.disabled ? 'Player disabled' : 'Player enabled');
      // The list row shows the status, and the block writes an audit row.
      qc.invalidateQueries({ queryKey: qk.playersKey });
      qc.invalidateQueries({ queryKey: qk.customerGacha(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.id) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const usePayoutDetails = (
  id: string | null,
): UseQueryResult<{ details: PayoutDetails | null }> =>
  useQuery({
    queryKey: qk.payoutDetails(id ?? ''),
    queryFn: () => getPayoutDetails(id!),
    enabled: !!id,
  });

export const useSavePayoutDetails = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; details: PayoutDetails }) =>
      savePayoutDetails(vars.id, vars.details),
    onSuccess: (_data, vars) => {
      toast.success('Bank details saved');
      qc.invalidateQueries({ queryKey: qk.payoutDetails(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.id) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// The player page's money card. Refetched by invalidateMoneyViews, which
// every money mutation calls.
export const useCustomerMoney = (
  id: string | null,
): UseQueryResult<CustomerMoney> =>
  useQuery({
    queryKey: qk.customerMoney(id ?? ''),
    queryFn: () => getCustomerMoney(id!),
    enabled: !!id,
  });

export const useSpendReport = (
  id: string | null,
): UseQueryResult<{ periods: { period: string; spend: number }[] }> =>
  useQuery({
    queryKey: qk.spendReport(id ?? ''),
    queryFn: () => getSpendReport(id!),
    enabled: !!id,
  });

// Shares the per-customer prefix with every other tab's key, so one customer
// invalidation reaches all of them (qk.customerDetail).
export const useCustomerDetail = (
  id: string | null,
): UseQueryResult<{ customer: AdminCustomerDetail }> =>
  useQuery({
    queryKey: qk.customerDetail(id ?? ''),
    queryFn: () => getCustomerDetail(id!),
    enabled: !!id,
  });

// ── Epic 3 (Odds) ────────────────────────────────────────────────────────────

export type { AdminCustomerGroup } from './admin-rest';

export const useCustomerGroupsAdmin = (): UseQueryResult<{
  customer_groups: AdminCustomerGroup[];
  count: number;
}> =>
  useQuery({ queryKey: qk.customerGroups, queryFn: listCustomerGroupsAdmin });

// Writes one group's metadata.odds_set. Invalidates the list so the saved value
// is re-read from the server rather than trusted from local state.
export const useSetGroupOddsSet = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; set: 1 | 2 | 3 }) =>
      setGroupOddsSet(vars.id, vars.set),
    onSuccess: () => {
      toast.success('Odds set saved');
      // Returned so the mutation stays pending until the refetch lands — the
      // Odds Sets page drops its local override in ITS onSuccess, and doing so
      // against a stale cache would flash the previous set.
      return qc.invalidateQueries({ queryKey: qk.customerGroups });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// Partner policy on one group (spec 2026-09-09). Same invalidate-and-wait
// shape as useSetGroupOddsSet so the row re-reads the server's answer.
export const useSetGroupPolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; policy: GroupPolicy; reason: string }) =>
      setGroupPolicy(vars.id, vars.policy, vars.reason),
    onSuccess: () => {
      toast.success('Group policy saved');
      return qc.invalidateQueries({ queryKey: qk.customerGroups });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// Odds set is chosen IN the create form, so a new group never spends a moment
// silently on set 1 (the create route takes metadata alongside the name).
export const useCreateCustomerGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; set: 1 | 2 | 3 }) =>
      createCustomerGroupAdmin(vars.name, vars.set),
    onSuccess: () => {
      toast.success('Player group created');
      return qc.invalidateQueries({ queryKey: qk.customerGroups });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// One query per group rather than one fat list query: the native
// customer-groups route has no member-count field, and asking it to embed
// `customers` would pull every member row of every group to count them.
// `enabled` keeps it from firing before the group list resolves.
export const useGroupPlayerCount = (
  groupId: string | undefined,
): UseQueryResult<number> =>
  useQuery({
    queryKey: qk.customerGroupCount(groupId ?? ''),
    queryFn: () => countCustomersInGroup(groupId!),
    enabled: !!groupId,
    // The QueryClient belongs to the prebuilt dashboard, so the defaults apply:
    // staleTime 0 + refetchOnWindowFocus. One row = one request, so every
    // alt-tab back would re-fire the whole column (up to the 100-group ceiling
    // this page assumes). A member count that is 30s old is never wrong enough
    // to matter; a move still updates it immediately via qk.customerGroupCounts.
    staleTime: 30_000,
  });

// Exclusive move (one repo-side request). Invalidates the group list — its
// member counts just shifted — plus the player's own detail row and the
// Players list, whose Group column is read straight off the customer.
export const useSetPlayerGroup = (customerId: string | null) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string | null) =>
      setCustomerGroup(customerId!, groupId),
    onSuccess: (res) => {
      toast.success(`Moved to ${res.group.name}`);
      return Promise.all([
        qc.invalidateQueries({
          queryKey: qk.customerDetail(customerId ?? ''),
        }),
        qc.invalidateQueries({ queryKey: qk.customerGroups }),
        qc.invalidateQueries({ queryKey: qk.customerGroupCounts }),
        qc.invalidateQueries({ queryKey: qk.playersKey }),
        invalidateMoneyViews(qc),
      ]);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// ── Epic 4 (Ledger) ──────────────────────────────────────────────────────────
// Own import block (same reason as Epic 2's above): keeps the section
// append-only while a parallel epic edits the top of this file.
import {
  listLedger,
  type AdminLedgerPage,
  type LedgerType,
} from './admin-rest';

export type { AdminLedgerRow, AdminLedgerPage, LedgerType } from './admin-rest';

// Paged + filtered, read-only, never id-scoped, so plain keepPreviousData is
// right (the whole page swaps together — no stale-row-click hazard, and this
// page has no row action to mis-fire anyway).
export const useLedger = (
  page: number,
  type?: LedgerType,
  q?: string,
  from?: string,
  to?: string,
  sort?: string,
): UseQueryResult<AdminLedgerPage> =>
  useQuery({
    queryKey: qk.ledger(page, type, q, from, to, sort),
    queryFn: () => listLedger(page, { type, q, from, to, sort }),
    placeholderData: keepPreviousData,
  });
// ── Epic 5 (Inventory) ───────────────────────────────────────────────────────
// Own import block (not merged into the one at the top) so this whole section
// stays append-only while a parallel epic edits the same file.
import {
  createPurchaseInvoice,
  getPurchaseInvoice,
  listPurchaseInvoices,
  type AdminPurchaseInvoiceDetail,
  type CreatePurchaseInvoiceBody,
  type PurchaseInvoicesPage,
} from './admin-rest';

export type {
  AdminPurchaseInvoice,
  AdminPurchaseInvoiceDetail,
  AdminPurchaseInvoiceLine,
  CreatePurchaseInvoiceBody,
  CreatePurchaseInvoiceLineBody,
  PurchaseInvoicesPage,
} from './admin-rest';

// Paged + searchable + sortable, not id-scoped, so plain keepPreviousData is
// right here (same call as usePlayers — the whole page swaps together).
export const usePurchaseInvoices = (
  page = 0,
  q?: string,
  sort = 'created_at:desc',
): UseQueryResult<PurchaseInvoicesPage> =>
  useQuery({
    queryKey: qk.purchaseInvoices(page, q, sort),
    queryFn: () => listPurchaseInvoices(page, q, 50, sort),
    placeholderData: keepPreviousData,
  });

export const usePurchaseInvoice = (
  id: string | null,
): UseQueryResult<{ invoice: AdminPurchaseInvoiceDetail }> =>
  useQuery({
    queryKey: qk.purchaseInvoice(id ?? ''),
    queryFn: () => getPurchaseInvoice(id!),
    enabled: !!id,
  });

// Three caches move here and one deliberately does not. The purchase-invoice
// LIST gains a row, so it goes. The purchase-invoice DETAIL does not: an invoice
// is immutable once written (no PUT/DELETE route exists), so no cached invoice
// detail can have gone stale — which is why qk.purchaseInvoice is a sibling
// namespace the list prefix cannot reach. That reasoning covers ONLY the invoice
// detail. The INVENTORY caches, list and item detail both, are a separate
// question and the answer is the opposite one: an invoice is not merely a
// document, it raises the Medusa stock counter and writes a `purchase` stock
// movement, so on_hand and the weighted-average cost change on the list and the
// movement history changes on the item detail. Without invalidating them the
// dashboard's 90 s staleTime (with refetchOnWindowFocus off) shows On Hand 0 and
// "No purchase history recorded" for stock the operator just bought. Since spec
// 2026-10-28 a save also re-runs the stock allocation (orders move to
// ready_to_ship) and can close a GRN by transfer — useInvalidateStock covers
// those caches along with both inventory roots.
export const useCreatePurchaseInvoice = () => {
  const qc = useQueryClient();
  const invalidateStock = useInvalidateStock();
  return useMutation({
    mutationFn: (body: CreatePurchaseInvoiceBody) =>
      createPurchaseInvoice(body),
    onSuccess: () => {
      toast.success('Purchase invoice created');
      qc.invalidateQueries({ queryKey: qk.purchaseInvoicesKey });
      invalidateStock();
    },
    // A refusal is often "that GRN is no longer open": refresh it so the form
    // shows its real status instead of failing the same way again.
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e));
      invalidateStock();
    },
  });
};

import { listInventory, type InventoryRow } from './admin-rest';

export type { InventoryRow } from './admin-rest';

// UNPAGED — the route returns every catalog row, because on_hand/cost/buckets
// are computed after the product read and can only be ordered client-side. So
// `q` is the only cache axis. keepPreviousData keeps the table on screen while
// the debounced search refetches (this endpoint pages the whole catalog and
// then makes five sequential per-handle service calls, so a blank-then-fill
// would flash on every keystroke).
export const useInventory = (
  q?: string,
): UseQueryResult<{ rows: InventoryRow[] }> =>
  useQuery({
    queryKey: qk.inventory(q),
    queryFn: () => listInventory(q),
    placeholderData: keepPreviousData,
  });

// Reaches BOTH inventory namespaces, the list AND the item detail. They are
// deliberate siblings (see qk.inventoryItem), so a prefix invalidation of one
// cannot touch the other. TWO of the three callers mutate both: the bulk
// register tool (routes/inventory/list/page.tsx) flips `is_card` on list rows
// cached under EVERY search key, not just the one on screen, and on each
// registered card's own detail page; creating a purchase invoice moves on_hand
// and cost on the list and appends the movement row the detail page exists to
// show. The THIRD, useCreateProductsFromPriceChartingBatch, moves the list only
// — a product that did not exist a moment ago has no cached detail to stale,
// and its page (/products/from-pricecharting) mounts no useInventoryItem, so
// the detail half marks nothing and refetches nothing. Harmless, and not worth
// a second list-only invalidator; just do not read this hook as proof that
// every caller needs both halves. Lives here rather than in the pages because no
// route file in this app touches useQueryClient or qk directly — cache surgery
// is this module's job. NOT folded into useRegisterCard's onSuccess: that hook
// is also the single-card register modal's, and the bulk tool calls it in a
// loop, so N registrations would trigger N refetches of an expensive list
// instead of one at the end.
export const useInvalidateInventory = () => {
  const qc = useQueryClient();
  // Returns the PROMISE, the two invalidations folded with Promise.all. The
  // bulk tool awaits this before it toasts (routes/inventory/list/page.tsx), so
  // a statement body returning void would resolve that await immediately and
  // announce "N registered" over a table that has not refetched yet. Awaiting a
  // non-promise is legal TypeScript, so the type checker will not catch that
  // regression -- do not "tidy" this back into a block.
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.inventoryKey }),
      qc.invalidateQueries({ queryKey: qk.inventoryItemKey }),
    ]);
};

import { getInventoryItem, type InventoryDetail } from './admin-rest';

export type { InventoryDetail, InventoryStockMovement } from './admin-rest';

// `page` pages the MOVEMENT HISTORY only — `item` and `associated` come back
// whole with every page, which is why the whole response is one cache entry
// keyed by (handle, page) rather than two queries. keepPreviousData keeps the
// header and the previous page of movements on screen while the next one
// loads, same call as usePurchaseInvoices.
export const useInventoryItem = (
  handle: string | null,
  page = 0,
): UseQueryResult<InventoryDetail> =>
  useQuery({
    queryKey: qk.inventoryItem(handle ?? '', page),
    queryFn: () => getInventoryItem(handle as string, page),
    enabled: !!handle,
    placeholderData: keepPreviousData,
  });

/** One queued PriceCharting import — exactly the single-item creation body. */
export type PcQueueItem = Parameters<typeof createProductFromPriceCharting>[0];

// Runs a client-side queue against the single-item creation endpoint —
// PriceCharting's API has no bulk-create endpoint for this to call instead
// (verified 2026-07-28 against the live API docs: /api/offer-publish is one
// item per POST, and PriceCharting's own docs point bulk-adders at a website
// CSV-upload tool, not an API). Calls the raw createProductFromPriceCharting
// rather than wrapping a per-item mutation: a per-item hook toasts its own
// failures, which would double up with the page's one batch-summary toast.
// The loop is deliberately SEQUENTIAL — each create re-fetches the card photo
// through the media pipeline server-side, so a Promise.all would fan N image
// ingests (and N pool connections) out at once.
export const useCreateProductsFromPriceChartingBatch = () => {
  const qc = useQueryClient();
  const invalidateInventory = useInvalidateInventory();
  return useMutation({
    mutationFn: async (items: PcQueueItem[]) => {
      let created = 0;
      const skipped: string[] = [];
      for (const item of items) {
        try {
          await createProductFromPriceCharting(item);
          created += 1;
        } catch (e) {
          skipped.push(
            `${item.name}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return { created, skipped };
    },
    onSuccess: ({ created }) => {
      if (created > 0) {
        qc.invalidateQueries({ queryKey: qk.cards });
        qc.invalidateQueries({ queryKey: qk.eligibleProducts });
        // This batch creates PRODUCTS, which is exactly the grain of the
        // Inventory list — without this a batch add leaves that list stale.
        invalidateInventory();
      }
    },
  });
};

// ── Referral rebuild (spec 2026-08-24) ───────────────────────────────────────

export type {
  CustomerReferralCard,
  ReferralSettings,
  ReferralSettlement,
  ReferralSettlementLine,
  ReferralTierWire,
} from './admin-rest';

export const useReferralSettings = (): UseQueryResult<ReferralSettings> =>
  useQuery({
    queryKey: qk.referralSettings,
    queryFn: getReferralSettings,
  });

export const useUpdateReferralSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      tiers?: ReferralTierWire[];
      partner_min_bp?: number;
      partner_max_bp?: number;
      reason: string;
    }) => updateReferralSettings(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.referralSettings }),
  });
};

export const useReferralSettlements = (): UseQueryResult<
  ReferralSettlement[]
> =>
  useQuery({
    queryKey: qk.referralSettlements,
    queryFn: listReferralSettlements,
  });

export const useReferralSettlement = (
  id: string | null,
): UseQueryResult<{
  settlement: ReferralSettlement;
  lines: ReferralSettlementLine[];
}> =>
  useQuery({
    queryKey: qk.referralSettlement(id ?? 'none'),
    queryFn: () => getReferralSettlement(id as string),
    enabled: id !== null,
  });

// approve / pay / void all reshape the run list AND the open detail — a plain
// prefix invalidation of qk.referralSettlements covers both (detail keys nest
// under the list key).
export const useApproveReferralSettlement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => approveReferralSettlement(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.referralSettlements }),
  });
};

export const usePayReferralSettlement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => payReferralSettlement(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.referralSettlements }),
  });
};

export const useVoidReferralSettlement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      voidReferralSettlement(vars.id, vars.reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.referralSettlements }),
  });
};

export const useSetCustomerReferrer = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      customerId: string;
      referrerId: string | null;
      reason: string;
    }) => setCustomerReferrer(vars.customerId, vars.referrerId, vars.reason),
    onSuccess: (_data, vars) => {
      // Every referral card, not just this player's: the old and the new
      // referrer's downline lists and week totals both change.
      qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === 'admin' &&
          q.queryKey[1] === 'customer' &&
          q.queryKey[3] === 'referral',
      });
      // The server writes an audit row — the History tab must see it.
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.customerId) });
    },
  });
};

export const useVoidReferralLine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { lineId: string; reason: string }) =>
      voidReferralLine(vars.lineId, vars.reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.referralSettlements }),
  });
};

export const useCustomerReferral = (
  customerId: string,
): UseQueryResult<CustomerReferralCard> =>
  useQuery({
    queryKey: qk.customerReferral(customerId),
    queryFn: () => getCustomerReferral(customerId),
  });

// Spec 2026-10-06: the two customer-service corrections. Both write an audit
// row (History tab), and the real name / phone read off the audit and detail
// queries.
export const useSetCustomerRealName = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      customerId: string;
      realName: string;
      reason: string;
    }) => setCustomerRealName(vars.customerId, vars.realName, vars.reason),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.customerId) });
    },
  });
};

export const useSetCustomerPhone = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { customerId: string; phone: string; reason: string }) =>
      setCustomerPhone(vars.customerId, vars.phone, vars.reason),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.customerDetail(vars.customerId) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.customerId) });
    },
  });
};

export const useSetPartnerRate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      customerId: string;
      rateBp: number | null;
      reason: string;
    }) => setPartnerRate(vars.customerId, vars.rateBp, vars.reason),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.customerReferral(vars.customerId) });
      // The server writes an audit row — the History tab must see it.
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.customerId) });
    },
  });
};

export type { AdminTaskDefinition } from './admin-rest';

export const useTaskDefinitions = (): UseQueryResult<AdminTaskDefinition[]> =>
  useQuery({ queryKey: qk.taskDefinitions, queryFn: listTaskDefinitions });

export const useSaveTaskDefinition = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof saveTaskDefinition>[0]) =>
      saveTaskDefinition(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.taskDefinitions }),
  });
};

// ── Lucky Draw (spec 2026-10-24) ─────────────────────────────────────────────
export type { AdminLuckyDrawEvent, AdminLuckyDrawPrize } from './admin-rest';

export const useLuckyDraw = (): UseQueryResult<AdminLuckyDrawEvent[]> =>
  useQuery({ queryKey: qk.luckyDraw, queryFn: listLuckyDraw });

// Every write refetches the overview: statuses, prize counts and the
// ticket / entrant totals all hang off it.
const useLuckyDrawWrite = <V, R>(fn: (vars: V) => Promise<R>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.luckyDraw }),
  });
};

export const useSaveLuckyDrawEvent = () =>
  useLuckyDrawWrite((v: Parameters<typeof saveLuckyDrawEvent>[0]) =>
    saveLuckyDrawEvent(v),
  );

export const usePublishLuckyDrawEvent = () =>
  useLuckyDrawWrite((v: { id: string; reason: string }) =>
    publishLuckyDrawEvent(v.id, v.reason),
  );

export const useWithdrawLuckyDrawEvent = () =>
  useLuckyDrawWrite((v: { id: string; reason: string }) =>
    withdrawLuckyDrawEvent(v.id, v.reason),
  );

export const useSaveLuckyDrawPrize = () =>
  useLuckyDrawWrite((v: Parameters<typeof saveLuckyDrawPrize>[0]) =>
    saveLuckyDrawPrize(v),
  );

export const useCancelLuckyDrawPrize = () =>
  useLuckyDrawWrite((v: { id: string; reason: string }) =>
    cancelLuckyDrawPrize(v.id, v.reason),
  );

// `prizeId` null = drawer closed: nothing to fetch.
export const useLuckyDrawEntries = (prizeId: string | null) =>
  useQuery({
    queryKey: qk.luckyDrawEntries(prizeId ?? ''),
    queryFn: () => listLuckyDrawEntries(prizeId as string),
    enabled: prizeId !== null,
  });

export const useLuckyDrawEventEntrants = (eventId: string) =>
  useQuery({
    queryKey: [...qk.luckyDraw, 'event-entrants', eventId],
    queryFn: () => listLuckyDrawEventEntrants(eventId),
  });

// Support lookup: only runs for a submitted id, and never caches a stale
// balance for long — the operator is usually checking a live complaint.
export const useLuckyDrawTickets = (customerId: string | null) =>
  useQuery({
    queryKey: qk.luckyDrawTickets(customerId ?? ''),
    queryFn: () => getLuckyDrawTickets(customerId as string),
    enabled: customerId !== null,
    staleTime: 0,
  });

export const useAdjustTickets = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      tickets: number;
      note: string;
      idempotencyKey?: string;
    }) =>
      adjustCustomerTickets(
        vars.id,
        vars.tickets,
        vars.note,
        vars.idempotencyKey,
      ),
    // Settled, not success: a lost response may still have committed.
    onSettled: (_data, _error, vars) => {
      qc.invalidateQueries({ queryKey: qk.luckyDrawTickets(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.id) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export type { AdminAnnouncement } from './admin-rest';

export const useAnnouncements = (): UseQueryResult<AdminAnnouncement[]> =>
  useQuery({ queryKey: qk.announcements, queryFn: listAnnouncements });

export const useSaveAnnouncement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof saveAnnouncement>[0]) =>
      saveAnnouncement(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.announcements }),
  });
};

export const useDeleteAnnouncement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      deleteAnnouncement(vars.id, vars.reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.announcements }),
  });
};

// ── Goods receive notes + procurement (spec 2026-10-28) ──────────────────────
import {
  createGoodsReceiveNote,
  getGoodsReceiveNote,
  getProcurementToBuy,
  getProcurementToShip,
  listGoodsReceiveNotes,
  reverseGoodsReceiveNote,
  type AdminGoodsReceiveNoteDetail,
  type CreateGoodsReceiveNoteBody,
  type GoodsReceiveNotesPage,
  type ProcurementToBuyRow,
} from './admin-rest';

export type {
  AdminGoodsReceiveNote,
  AdminGoodsReceiveNoteDetail,
  AdminGoodsReceiveNoteLine,
  CreateGoodsReceiveNoteBody,
  GoodsReceiveNotesPage,
  GrnStatus,
  ProcurementToBuyRow,
} from './admin-rest';

// Everything a GRN save, a GRN reversal or an invoice save can move: on hand
// and the buckets (both inventory roots), the two daily lists, a GRN's status
// (open -> transferred / reversed), and order statuses — the server re-runs
// the oldest-first stock allocation after every save, moving orders to
// processed / ready_to_ship. Returns the folded promise, like
// useInvalidateInventory, so a caller can await the refetch.
export const useInvalidateStock = () => {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [
        qk.inventoryKey,
        qk.inventoryItemKey,
        qk.procurementKey,
        qk.deliveryOrdersKey,
        qk.deliveryOrderKey,
        qk.goodsReceiveNotesKey,
        qk.goodsReceiveNoteKey,
      ].map((queryKey) => qc.invalidateQueries({ queryKey })),
    );
};

export const useGoodsReceiveNotes = (
  page = 0,
  q?: string,
  sort = 'created_at:desc',
): UseQueryResult<GoodsReceiveNotesPage> =>
  useQuery({
    queryKey: qk.goodsReceiveNotes(page, q, sort),
    queryFn: () => listGoodsReceiveNotes(page, q, 50, sort),
    placeholderData: keepPreviousData,
  });

// The invoice form's transfer picker: GRNs still waiting for their invoice,
// newest first, one page of the route's max 100. Gated on `enabled` (the
// picker drawer being open) — it is modal-only data; a ?from_grn= deep link
// loads its one GRN through useGoodsReceiveNote instead.
//
// shortcut: an open GRN older than the newest 100 cannot be picked here; its
// detail page's "Transfer to purchase invoice" button still reaches it.
export const useOpenGoodsReceiveNotes = (
  enabled: boolean,
): UseQueryResult<GoodsReceiveNotesPage> =>
  useQuery({
    queryKey: qk.goodsReceiveNotes(0, undefined, 'created_at:desc', 'open'),
    queryFn: () =>
      listGoodsReceiveNotes(0, undefined, 100, 'created_at:desc', 'open'),
    enabled,
  });

export const useGoodsReceiveNote = (
  id: string | null,
): UseQueryResult<{ goods_receive_note: AdminGoodsReceiveNoteDetail }> =>
  useQuery({
    queryKey: qk.goodsReceiveNote(id ?? ''),
    queryFn: () => getGoodsReceiveNote(id as string),
    enabled: !!id,
  });

export const useCreateGoodsReceiveNote = () => {
  const { t } = useTranslation();
  const invalidateStock = useInvalidateStock();
  return useMutation({
    mutationFn: (body: CreateGoodsReceiveNoteBody) =>
      createGoodsReceiveNote(body),
    onSuccess: () => {
      toast.success(t('grn.created'));
      invalidateStock();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

// The reverse route does not re-run the allocation, but on hand drops, so the
// buckets and the to-buy list still move — same invalidation as a save.
export const useReverseGoodsReceiveNote = () => {
  const { t } = useTranslation();
  const invalidateStock = useInvalidateStock();
  return useMutation({
    mutationFn: (id: string) => reverseGoodsReceiveNote(id),
    onSuccess: () => {
      toast.success(t('grn.reversed'));
      invalidateStock();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useProcurementToBuy = (): UseQueryResult<{
  rows: ProcurementToBuyRow[];
  taken_at: string | null;
}> =>
  useQuery({
    queryKey: qk.procurementToBuy,
    queryFn: getProcurementToBuy,
    // A page left open past 12am picks up the new list on return, or within
    // ten minutes while it stays in front.
    refetchOnWindowFocus: true,
    refetchInterval: 10 * 60 * 1000,
  });

export const useProcurementToShip = (): UseQueryResult<{
  orders: AdminDeliveryOrder[];
}> =>
  useQuery({
    queryKey: qk.procurementToShip,
    queryFn: getProcurementToShip,
  });

// ── Dashboard (spec §7) ──────────────────────────────────────────────────────
// Light reads for the home page: a count per delivery status (limit 1, only
// `total` is used) and the newest few payments, instead of 50-row pages.

export const useDeliveryOrderCount = (
  status: DeliveryStatus,
): UseQueryResult<number> =>
  useQuery({
    queryKey: qk.deliveryOrderCount(status),
    queryFn: () => listDeliveryOrders(status, 0, undefined, 1),
    select: (page) => page.total,
  });

export const useRecentGatewayDeposits = (
  limit: number,
): UseQueryResult<GatewayDepositsResponse> =>
  useQuery({
    queryKey: qk.recentGatewayDeposits(limit),
    // 'settled', not 'all': an unpaid or cancelled cashier is not a payment.
    queryFn: () => getGatewayDeposits(0, 'settled', limit),
  });

export const useRecentGatewayWithdrawals = (
  limit: number,
): UseQueryResult<GatewayWithdrawalsResponse> =>
  useQuery({
    queryKey: qk.recentGatewayWithdrawals(limit),
    queryFn: () => getGatewayWithdrawals(0, 'all', limit),
  });
