import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { toast } from '@medusajs/ui';
import {
  packsApi,
  type AdminCard,
  type AdminCardRegister,
  type AdminCardUpdate,
  type AdminPack,
  type AdminPackWrite,
  type PackOddsResponse,
  type PullsResponse,
} from './packs-api';
import {
  adjustCustomerCredits,
  bulkUpdateDeliveryOrders,
  createProductFromPriceCharting,
  deleteCard,
  deletePack,
  freezeCustomer,
  getAvatarFrames,
  getChallengeSettings,
  getChallengeStages,
  getCustomerAudit,
  getCustomerGacha,
  getCustomerCommissions,
  getCustomerTransactions,
  getCustomerPulls,
  getDeliveryOrder,
  getEconomyReport,
  getFxHistory,
  getFxRate,
  getPulls,
  getGlobePayDeposits,
  type GlobePayDepositView,
  type GlobePayDepositsResponse,
  getPixelPokemon,
  createPixelPokemon,
  type PixelPokemonPage,
  type PixelPokemonQuery,
  type CreatePixelPokemonBody,
  getDailyBoxes,
  getDailyBox,
  getVoucherLadder,
  getReferralTree,
  getRewardsSettings,
  getSiteSettings,
  getVipLevels,
  listDeliveryOrders,
  listEligibleProducts,
  reverseCommission,
  saveAvatarFrames,
  saveChallengeSettings,
  saveChallengeStages,
  saveDailyBox,
  saveRewardsSettings,
  saveSiteSettings,
  saveVipLevels,
  saveVoucherRanges,
  setFxRate,
  suspendCommission,
  unfreezeCustomer,
  unsuspendCommission,
  updateDeliveryOrder,
  uploadImage,
  type AdminCommissionRow,
  type AdminDeliveryOrder,
  type AvatarFramesView,
  type ChallengeSettingsDTO,
  type ChallengeStageDTO,
  type CustomerAudit,
  type CustomerGacha,
  type SupportTransaction,
  type SupportPull,
  type DailyBoxEditorDTO,
  type DailyBoxSaveBody,
  type DailyBoxSummary,
  type DeliveryOrdersPage,
  type DeliveryStatus,
  type EconomyReport,
  type EligibleProduct,
  type FxChange,
  type FxRateState,
  type ReferralTree,
  type RewardsSettingsView,
  type SiteSettingsView,
  type VipLevelDTO,
  type VoucherLadderDTO,
  type VoucherRangeDTO,
  // ── Epic 3 (Odds) ──
  listCustomerGroupsAdmin,
  setGroupOddsSet,
  type AdminCustomerGroup,
} from './admin-rest';
import type { SetEntry } from '@acme/odds-math';
import { qk } from './query-keys';

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
): UseQueryResult<PixelPokemonPage> =>
  useQuery({
    queryKey: ['pixel-pokemon', params],
    queryFn: () => getPixelPokemon(params),
    placeholderData: keepPreviousData,
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

// from/to are ISO strings for the period window (undefined = all time). Appended
// to the key inline so qk.economy stays a flat prefix (query-keys.test.ts).
// keepPreviousData avoids a skeleton flash when switching periods.
export const useEconomy = (
  from?: string,
  to?: string,
): UseQueryResult<EconomyReport> =>
  useQuery({
    queryKey: [...qk.economy, from ?? 'all', to ?? 'all'],
    queryFn: () => getEconomyReport(from, to),
    placeholderData: keepPreviousData,
  });

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

export const useReferralTree = (
  id: string | null,
  maxDepth = 6,
): UseQueryResult<ReferralTree> =>
  useQuery({
    queryKey: qk.referralTree(id ?? '', maxDepth),
    queryFn: () => getReferralTree(id!, maxDepth),
    enabled: !!id,
  });

// keepPreviousData, but scoped to the SAME customer (queryKey[2] is the id —
// see qk.customerCommissions/customerAudit): page flips keep the previous
// page's rows (no skeleton flash), while navigating to another /customers/:id
// blanks the tables. Unscoped keepPreviousData left the PRIOR customer's
// commission rows visible and clickable during the switch — reversing one
// submitted the stale commId while invalidating the new customer's caches.
export const useCustomerCommissions = (
  id: string | null,
  page = 0,
): UseQueryResult<{ commissions: AdminCommissionRow[] }> =>
  useQuery({
    queryKey: qk.customerCommissions(id ?? '', page),
    queryFn: () => getCustomerCommissions(id!, page),
    enabled: !!id,
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === (id ?? '') ? prev : undefined,
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
): UseQueryResult<{ items: SupportTransaction[]; total: number }> =>
  useQuery({
    queryKey: qk.customerTransactions(id ?? '', page),
    queryFn: () => getCustomerTransactions(id!, page),
    enabled: !!id,
    placeholderData: keepPreviousData,
  });

// `opts` narrows the history server-side and is part of the cache key, so the
// Vault tab's vaulted-only view and the support page's full history are
// separate entries instead of overwriting each other for the same (id, page).
export const useCustomerPulls = (
  id: string | null,
  page = 0,
  // status only — getCustomerPulls also accepts `source`, but nothing needs it
  // here and an un-keyed filter would collide in the cache.
  opts?: { status?: string },
): UseQueryResult<{
  items: SupportPull[];
  total: number;
  fx?: { rate: number; firm: boolean };
}> =>
  useQuery({
    queryKey: qk.customerPulls(id ?? '', page, opts?.status),
    queryFn: () => getCustomerPulls(id!, page, 25, opts),
    enabled: !!id,
    placeholderData: keepPreviousData,
  });

// `customerId` scopes the table to one player. listDeliveryOrders takes `limit`
// BEFORE it (4th arg), so the default 50 is passed explicitly here.
export const useDeliveryOrders = (
  status?: DeliveryStatus,
  page = 0,
  q?: string,
  customerId?: string,
): UseQueryResult<DeliveryOrdersPage> =>
  useQuery({
    queryKey: qk.deliveryOrders(status, page, q, customerId),
    queryFn: () => listDeliveryOrders(status, page, q, 50, customerId),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.cards }),
  });
};

export const useDeleteCard = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) => deleteCard(handle),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.cards }),
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

export const useAdjustCredits = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; amount: number; note: string }) =>
      adjustCustomerCredits(vars.id, vars.amount, vars.note),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.customerGacha(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerTransactionsKey(vars.id) });
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
      qc.invalidateQueries({ queryKey: qk.referralTreeKey(vars.id) });
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
      qc.invalidateQueries({ queryKey: qk.referralTreeKey(vars.id) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useReverseCommission = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      commId: string;
      customerId: string;
      reason: string;
    }) => reverseCommission(vars.commId, vars.reason),
    onSuccess: (_data, vars) => {
      toast.success('Commission reversed');
      qc.invalidateQueries({
        queryKey: qk.customerCommissionsKey(vars.customerId),
      });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.customerId) });
      // Reversal inserts a negative credit_transaction (clawback) and may
      // auto-freeze on a negative balance — refresh the header balance + ledger.
      qc.invalidateQueries({ queryKey: qk.customerGacha(vars.customerId) });
      qc.invalidateQueries({
        queryKey: qk.customerTransactionsKey(vars.customerId),
      });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useSuspendCommission = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      commId: string;
      customerId: string;
      reason: string;
    }) => suspendCommission(vars.commId, vars.reason),
    onSuccess: (_data, vars) => {
      toast.success('Commission suspended');
      qc.invalidateQueries({
        queryKey: qk.customerCommissionsKey(vars.customerId),
      });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.customerId) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useUnsuspendCommission = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      commId: string;
      customerId: string;
      reason: string;
    }) => unsuspendCommission(vars.commId, vars.reason),
    onSuccess: (_data, vars) => {
      toast.success('Commission unsuspended');
      qc.invalidateQueries({
        queryKey: qk.customerCommissionsKey(vars.customerId),
      });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.customerId) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useUploadImage = () =>
  useMutation({
    mutationFn: (vars: {
      file: File;
      kind: 'pack' | 'display' | 'card' | 'sprite' | 'frame' | 'avatar-frame' | 'delivery';
    }) => uploadImage(vars.file, vars.kind),
  });

export const useUpdateDeliveryOrder = () => {
  const qc = useQueryClient();
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
    // Status filters + pages vary, so drop the whole delivery-orders namespace.
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.deliveryOrdersKey }),
  });
};

export const useBulkUpdateDeliveryOrders = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { ids: string[]; status: DeliveryStatus }) =>
      bulkUpdateDeliveryOrders(vars.ids, vars.status),
    // Partial success is the contract, so invalidate on SETTLE (not success):
    // a throw here can still leave earlier ids in the batch already moved.
    onSettled: () => qc.invalidateQueries({ queryKey: qk.deliveryOrdersKey }),
  });
};

export type {
  DailyBoxEditorDTO,
  DailyBoxPrizeDTO,
  DailyBoxSummary,
  VoucherLadderDTO,
  VoucherRangeDTO,
} from './admin-rest';

export const useDailyBoxes = (): UseQueryResult<{ boxes: DailyBoxSummary[] }> =>
  useQuery({ queryKey: qk.dailyBoxes, queryFn: getDailyBoxes });

export const useDailyBox = (tier: string): UseQueryResult<DailyBoxEditorDTO> =>
  useQuery({
    queryKey: qk.dailyBox(tier),
    queryFn: () => getDailyBox(tier),
    enabled: !!tier,
  });

export const useSaveDailyBox = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { tier: string; body: DailyBoxSaveBody }) =>
      saveDailyBox(vars.tier, vars.body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.dailyBoxes });
      qc.invalidateQueries({ queryKey: qk.dailyBox(vars.tier) });
      toast.success('Box saved');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

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
}> =>
  useQuery({ queryKey: qk.challengeStages, queryFn: getChallengeStages });

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

// GlobePay deposits. Polls once a minute: this is the money-in watch list, and a
// stranded payment should surface without an operator remembering to reload.
export const useGlobePayDeposits = (
  page = 0,
  status: GlobePayDepositView = 'pending',
): UseQueryResult<GlobePayDepositsResponse> =>
  useQuery({
    queryKey: qk.globepayDeposits(page, status),
    queryFn: () => getGlobePayDeposits(page, status),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
// ── Epic 2 (Players) ─────────────────────────────────────────────────────────
// Own import block (not merged into the one at the top) so this whole section
// stays append-only while a parallel epic edits the same file.
import {
  disablePlayer,
  enablePlayer,
  getCustomerDetail,
  getPayoutDetails,
  getSpendReport,
  listPlayers,
  savePayoutDetails,
  type AdminCustomerDetail,
  type PayoutDetails,
  type PlayersPage,
} from './admin-rest';

export type { PlayerRow, PlayersPage, PayoutDetails } from './admin-rest';

// Paged + searchable, but NOT id-scoped, so plain keepPreviousData is right
// here (no stale-row-click hazard — the whole page swaps together).
export const usePlayers = (
  page = 0,
  q?: string,
): UseQueryResult<PlayersPage> =>
  useQuery({
    queryKey: qk.players(page, q),
    queryFn: () => listPlayers(page, q),
    placeholderData: keepPreviousData,
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

export const useSpendReport = (
  id: string | null,
): UseQueryResult<{ periods: { period: string; spend: number }[] }> =>
  useQuery({
    queryKey: qk.spendReport(id ?? ''),
    queryFn: () => getSpendReport(id!),
    enabled: !!id,
  });

// Keyed inline (qk carries no customerDetail entry) so the per-customer prefix
// still reaches it — same pattern as useEconomy's inline period segments.
export const useCustomerDetail = (
  id: string | null,
): UseQueryResult<{ customer: AdminCustomerDetail }> =>
  useQuery({
    queryKey: ['admin', 'customer', id ?? '', 'detail'],
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
): UseQueryResult<AdminLedgerPage> =>
  useQuery({
    queryKey: qk.ledger(page, type, q, from, to),
    queryFn: () => listLedger(page, { type, q, from, to }),
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
// "No purchase history recorded" for stock the operator just bought.
export const useCreatePurchaseInvoice = () => {
  const qc = useQueryClient();
  const invalidateInventory = useInvalidateInventory();
  return useMutation({
    mutationFn: (body: CreatePurchaseInvoiceBody) =>
      createPurchaseInvoice(body),
    onSuccess: () => {
      toast.success('Purchase invoice created');
      qc.invalidateQueries({ queryKey: qk.purchaseInvoicesKey });
      invalidateInventory();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
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
