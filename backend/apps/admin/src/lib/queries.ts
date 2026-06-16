import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
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
  deleteCard,
  deletePack,
  getCustomerGacha,
  getEconomyReport,
  listEligibleProducts,
  uploadImage,
  type CustomerGacha,
  type EconomyReport,
  type EligibleProduct,
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

export const useAdjustCredits = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; amount: number; note: string }) =>
      adjustCustomerCredits(vars.id, vars.amount, vars.note),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: qk.customerGacha(vars.id) }),
  });
};

export const useUploadImage = () =>
  useMutation({
    mutationFn: (vars: { file: File; kind: 'pack' | 'card' }) =>
      uploadImage(vars.file, vars.kind),
  });
