import type { DailyRewardSettingsDTO } from './admin-rest';
import {
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
  createProductFromPriceCharting,
  deleteCard,
  deletePack,
  freezeCustomer,
  getCustomerAudit,
  getCustomerGacha,
  getCustomerCommissions,
  getEconomyReport,
  getFxRate,
  getDailyRewardSettings,
  getRewardPool,
  getReferralTree,
  listDeliveryOrders,
  listEligibleProducts,
  reverseCommission,
  saveDailyRewardSettings,
  saveRewardPool,
  setFxRate,
  suspendCommission,
  unfreezeCustomer,
  unsuspendCommission,
  updateDeliveryOrder,
  uploadImage,
  type AdminCommissionRow,
  type AdminDeliveryOrder,
  type CustomerAudit,
  type CustomerGacha,
  type DeliveryStatus,
  type EconomyReport,
  type EligibleProduct,
  type FxRateState,
  type ReferralTree,
  type RewardPoolBody,
  type RewardPoolResponse,
} from './admin-rest';
import type { OddsInput } from '@acme/odds-math';
import { qk } from './query-keys';

// ── Display queries ──────────────────────────────────────────────────────────

export const usePacks = (): UseQueryResult<AdminPack[]> =>
  useQuery({
    queryKey: qk.packs,
    queryFn: () => packsApi.admin.packs.query().then((r) => r.packs),
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

export const usePulls = (): UseQueryResult<PullsResponse> =>
  useQuery({ queryKey: qk.pulls, queryFn: () => packsApi.admin.pulls.query() });

export const useEconomy = (): UseQueryResult<EconomyReport> =>
  useQuery({ queryKey: qk.economy, queryFn: getEconomyReport });

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

export const useCustomerCommissions = (
  id: string | null,
  page = 0,
): UseQueryResult<{ commissions: AdminCommissionRow[] }> =>
  useQuery({
    queryKey: qk.customerCommissions(id ?? '', page),
    queryFn: () => getCustomerCommissions(id!, page),
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
  });

export const useDeliveryOrders = (
  status?: DeliveryStatus,
): UseQueryResult<AdminDeliveryOrder[]> =>
  useQuery({
    queryKey: qk.deliveryOrders(status),
    queryFn: () => listDeliveryOrders(status),
  });

export const useFxRate = (): UseQueryResult<FxRateState> =>
  useQuery({ queryKey: qk.fxRate, queryFn: getFxRate });

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
      qc.invalidateQueries({ queryKey: qk.eligibleProducts });
    },
  });
};

export const useCreateProductFromPriceCharting = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createProductFromPriceCharting,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.cards });
      qc.invalidateQueries({ queryKey: qk.eligibleProducts });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useSetFxRate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: setFxRate,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.fxRate });
      qc.invalidateQueries({ queryKey: qk.cards });
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
    mutationFn: (vars: { slug: string; entries: OddsInput[] }) =>
      packsApi.admin.packs.$slug.odds.mutate({
        $slug: vars.slug,
        entries: vars.entries,
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
      qc.invalidateQueries({
        queryKey: qk.customerCommissionsKey(vars.customerId),
      });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.customerId) });
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
    mutationFn: (vars: { file: File; kind: 'pack' | 'card' | 'sprite' }) =>
      uploadImage(vars.file, vars.kind),
  });

export const useUpdateDeliveryOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      status?: DeliveryStatus;
      tracking_number?: string | null;
    }) =>
      updateDeliveryOrder(vars.id, {
        status: vars.status,
        tracking_number: vars.tracking_number,
      }),
    // Status filters vary, so drop the whole delivery-orders namespace.
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['admin', 'delivery-orders'] }),
  });
};

export const useRewardPool = (
  tier: string,
): UseQueryResult<RewardPoolResponse> =>
  useQuery({
    queryKey: qk.rewardPool(tier),
    queryFn: () => getRewardPool(tier),
    enabled: !!tier,
  });

export const useSaveRewardPool = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { tier: string; body: RewardPoolBody }) =>
      saveRewardPool(vars.tier, vars.body),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: qk.rewardPool(vars.tier) }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};

export const useDailyRewardSettings =
  (): UseQueryResult<DailyRewardSettingsDTO> =>
    useQuery({
      queryKey: qk.dailyRewardSettings,
      queryFn: getDailyRewardSettings,
    });

export const useSaveDailyRewardSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      enabled: boolean;
      amounts: number[];
      reason: string;
    }) => saveDailyRewardSettings(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.dailyRewardSettings });
      toast.success('Daily reward settings saved');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};
