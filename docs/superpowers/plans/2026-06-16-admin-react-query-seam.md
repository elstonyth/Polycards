# Admin React Query Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled `fetch + useEffect + mount-guard` loading pattern across the admin route pages with a centralized React Query seam, eliminating the unguarded `reloadOdds` refetch.

**Architecture:** One new data-only module `backend/apps/admin/src/lib/queries.ts` owns query keys + display-query hooks + mutation hooks (with cache invalidation). The dashboard already provides `<QueryClientProvider>`, so pages call `useQuery`/`useMutation` against the existing context. Pages keep their own i18n toasts via `mutateAsync` in try/catch. The win-rate lock path is kept byte-identical: only `saveMembers` invalidates; `saveOdds` keeps its in-place response-patch.

**Tech Stack:** React 18, `@tanstack/react-query@5.64.2` (already a dep, pinned to the dashboard's copy), `@medusajs/ui`, Vite, TypeScript strict.

**Design spec:** `docs/superpowers/specs/2026-06-16-admin-react-query-seam-design.md`

---

## Conventions for every task

- **Work dir:** repo root `C:\Users\PC\Desktop\Projects\Pokenic_Game`. Backend commands run from `backend/` with `corepack yarn`.
- **Branch:** `refactor/admin-react-query-seam` (already created; spec already committed).
- **Per-task verification:**
  - The repo's PostToolUse hook auto-runs `tsc` after each `.ts`/`.tsx` edit — confirm it reports no errors.
  - Lint the app: `cd backend && corepack yarn workspace @acme/admin run lint`
  - Expected: `eslint .` exits 0 (no errors).
- **Final verification (Task 9):** full build + lint.
- **No behavior change** to JSX/markup beyond swapping the data-source variables and loading/error flags. Do not touch `usd` / `fmtPct` / `timeAgo` (Candidate D, separate PR).

## File map

| File | Action | Responsibility |
|---|---|---|
| `backend/apps/admin/src/lib/queries.ts` | Create | Query keys + display/mutation hooks (data seam) |
| `backend/apps/admin/src/routes/pulls/page.tsx` | Modify | use `usePulls` |
| `backend/apps/admin/src/routes/economy/page.tsx` | Modify | use `useEconomy` |
| `backend/apps/admin/src/routes/cards/page.tsx` | Modify | `useCards` + card mutations |
| `backend/apps/admin/src/routes/packs/page.tsx` | Modify | `usePacks` + pack mutations |
| `backend/apps/admin/src/routes/cards/RegisterCardModal.tsx` | Modify | `useEligibleProducts` + `useRegisterCard` |
| `backend/apps/admin/src/routes/packs/[slug]/page.tsx` | Modify | `usePackOdds` + seeding effect; delete `reloadOdds` |
| `backend/apps/admin/src/routes/support/page.tsx` | Modify | `useCustomerGacha` + `useAdjustCredits` (partial) |

---

## Task 1: Create the data seam (`lib/queries.ts`)

**Files:**
- Create: `backend/apps/admin/src/lib/queries.ts`

- [ ] **Step 1: Create the file with the full seam**

```ts
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

// Centralized query keys for the gacha admin pages. Hierarchical so a pack-level
// invalidation can target the odds without touching the pack list.
export const qk = {
  packs: ['admin', 'packs'] as const,
  pack: (slug: string) => ['admin', 'pack', slug] as const,
  packOdds: (slug: string) => ['admin', 'pack', slug, 'odds'] as const,
  cards: ['admin', 'cards'] as const,
  pulls: ['admin', 'pulls'] as const,
  economy: ['admin', 'economy'] as const,
  eligibleProducts: ['admin', 'eligible-products'] as const,
  customerGacha: (id: string) => ['admin', 'customer', id, 'gacha'] as const,
};

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
```

- [ ] **Step 2: Lint + typecheck**

Run: `cd backend && corepack yarn workspace @acme/admin run lint`
Expected: exits 0. Confirm the auto typecheck hook reports no errors for `queries.ts`.

- [ ] **Step 3: Commit**

```bash
git add backend/apps/admin/src/lib/queries.ts
git commit -m "feat(admin): add React Query data seam (lib/queries.ts)"
```

---

## Task 2: Migrate `pulls/page.tsx`

**Files:**
- Modify: `backend/apps/admin/src/routes/pulls/page.tsx`

- [ ] **Step 1: Swap the React import for the hook import**

Replace line 1:
```ts
import { useEffect, useState } from "react";
```
with:
```ts
import { usePulls } from "../../lib/queries";
```
(The file uses no other React hooks; `useTranslation` and the module-level `usd`/`timeAgo` helpers stay.)

Remove the now-unused `type PullsResponse` from the existing `packs-api` import on line 6 — change:
```ts
import { packsApi, type PullsResponse } from "../../lib/packs-api";
```
to:
```ts
import { resolveImageUrl } from "../../lib/image-url";
```
…**no** — keep `resolveImageUrl` as-is (line 7). Instead just drop `packsApi` and `PullsResponse`: delete line 6 entirely (both are now unused; `usePulls` wraps them).

- [ ] **Step 2: Replace the state + effect with the hook**

Replace this block (current lines 30-43):
```ts
  const { t } = useTranslation();
  const [data, setData] = useState<PullsResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    packsApi.admin.pulls
      .query()
      .then((res) => active && setData(res))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);
```
with:
```ts
  const { t } = useTranslation();
  const { data, isError } = usePulls();
```

- [ ] **Step 3: Update the loading/error guards in JSX**

In the first `Container`, change the conditional (current lines 55-63):
- `{error ? (` → `{isError ? (`
- `) : data === null ? (` → `) : !data ? (`

(`data && data.pulls.length > 0` later stays valid — `undefined` is falsy.)

- [ ] **Step 4: Lint**

Run: `cd backend && corepack yarn workspace @acme/admin run lint`
Expected: exits 0. Confirm auto typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add backend/apps/admin/src/routes/pulls/page.tsx
git commit -m "refactor(admin): pulls page uses usePulls query"
```

---

## Task 3: Migrate `economy/page.tsx`

**Files:**
- Modify: `backend/apps/admin/src/routes/economy/page.tsx`

- [ ] **Step 1: Swap imports**

Replace line 1:
```ts
import { useEffect, useState } from "react";
```
with:
```ts
import { useEconomy } from "../../lib/queries";
```
Replace line 6:
```ts
import { getEconomyReport, type EconomyReport } from "../../lib/admin-rest";
```
with:
```ts
import { type EconomyReport } from "../../lib/admin-rest";
```
(`EconomyReport` is still referenced by the `stats` type annotation; keep it. `getEconomyReport` moves into the hook.)

- [ ] **Step 2: Replace state + effect**

Replace current lines 19-31:
```ts
  const { t } = useTranslation();
  const [data, setData] = useState<EconomyReport | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    getEconomyReport()
      .then((res) => active && setData(res))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);
```
with:
```ts
  const { t } = useTranslation();
  const { data, isError } = useEconomy();
```

The `stats` derivation immediately below uses `data ? [...] : []` — leave it; `data` is now `EconomyReport | undefined`, still works. If TypeScript flags the unused `EconomyReport` import after this, keep it only if `stats` still annotates it; otherwise drop it. (The `stats` declaration `const stats: { key: string; value: string; hint?: string }[]` does **not** reference `EconomyReport`, so **remove `EconomyReport` from the import** — make line 6: `import {} from` is invalid, so delete line 6 entirely.)

- [ ] **Step 3: Update JSX guards**

- `{error ? (` → `{isError ? (`
- `) : data === null ? (` → `) : !data ? (`

- [ ] **Step 4: Lint**

Run: `cd backend && corepack yarn workspace @acme/admin run lint`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add backend/apps/admin/src/routes/economy/page.tsx
git commit -m "refactor(admin): economy page uses useEconomy query"
```

---

## Task 4: Migrate `cards/page.tsx`

**Files:**
- Modify: `backend/apps/admin/src/routes/cards/page.tsx`

- [ ] **Step 1: Swap imports**

Change line 1:
```ts
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
```
to:
```ts
import { useRef, useState, type ChangeEvent } from 'react';
```
Change the `packs-api` import (lines 19-23) to drop `packsApi` (now only types are needed):
```ts
import {
  type AdminCard,
  type AdminCardUpdate,
} from '../../lib/packs-api';
```
Change line 24:
```ts
import { uploadImage, deleteCard } from '../../lib/admin-rest';
```
to add the hook import (and remove the direct fns — they live in hooks now):
```ts
import {
  useCards,
  useDeleteCard,
  useUpdateCard,
  useUploadImage,
} from '../../lib/queries';
```

- [ ] **Step 2: Replace the cards state + effect + reload with hooks**

Replace current lines 67-95:
```ts
  const { t } = useTranslation();
  const [cards, setCards] = useState<AdminCard[] | null>(null);
  const [error, setError] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminCard | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    packsApi.admin.cards
      .query()
      .then((res) => active && setCards(res.cards))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);

  const reload = async () => {
    try {
      const res = await packsApi.admin.cards.query();
      setCards(res.cards);
    } catch {
      toast.error(t('cards.list.loadError'));
    }
  };
```
with:
```ts
  const { t } = useTranslation();
  const { data: cards = null, isError } = useCards();
  const updateCard = useUpdateCard();
  const removeCard = useDeleteCard();
  const uploadImg = useUploadImage();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminCard | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = uploadImg.isPending;
  const saving = updateCard.isPending;
```

- [ ] **Step 3: Rewrite `handleFile` to use the upload mutation**

Replace current lines 100-121 (`const handleFile = …`) with:
```ts
  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side gate: instant reject before the upload round-trip. The
    // server re-validates (and is authoritative).
    const problem = await validateImageFile(file, 'card');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const url = await uploadImg.mutateAsync({ file, kind: 'card' });
      patch({ image: url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
```

- [ ] **Step 4: Rewrite `save` and `confirmDelete` to use the mutations**

Replace current lines 132-171 (`const save = …` through the end of `confirmDelete`) with:
```ts
  const save = async () => {
    if (!form || !canSave) return;
    const payload: AdminCardUpdate = {
      name: form.name.trim(),
      set: form.set.trim(),
      grader: form.grader.trim(),
      grade: form.grade.trim(),
      market_value: Number(form.market_value),
      image: form.image.trim(),
      price: form.price.trim() === '' ? undefined : Number(form.price),
      for_sale: form.for_sale,
    };
    try {
      await updateCard.mutateAsync({ handle: form.handle, ...payload });
      toast.success(t('cards.toast.updated'));
      setForm(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const handle = deleteTarget.handle;
    setDeleteTarget(null);
    try {
      await removeCard.mutateAsync(handle);
      toast.success(t('cards.toast.deleted'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
```

- [ ] **Step 5: Update list guards + the RegisterCardModal prop**

In the table conditional (current lines 191-203): change `{error ? (` → `{isError ? (`. The `cards === null` and `cards.length === 0` branches stay valid (`cards` defaults to `null` while loading).

Change the `RegisterCardModal` usage (current lines 302-306):
```tsx
      <RegisterCardModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onRegistered={reload}
      />
```
to:
```tsx
      <RegisterCardModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
      />
```
(The register mutation invalidates `cards`, so no manual reload prop is needed. The `onRegistered` prop is removed in Task 6.)

- [ ] **Step 6: Lint**

Run: `cd backend && corepack yarn workspace @acme/admin run lint`
Expected: exits 0. Confirm auto typecheck clean (watch for unused `AdminCard` — it's still used by `formFromCard`, `deleteTarget`, `gradeLabel`, so it stays).

- [ ] **Step 7: Commit**

```bash
git add backend/apps/admin/src/routes/cards/page.tsx
git commit -m "refactor(admin): cards page uses query + mutation hooks"
```

---

## Task 5: Migrate `packs/page.tsx`

**Files:**
- Modify: `backend/apps/admin/src/routes/packs/page.tsx`

- [ ] **Step 1: Swap imports**

Change line 1:
```ts
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
```
to:
```ts
import { useRef, useState, type ChangeEvent } from 'react';
```
Change the `packs-api` import (lines 21-25) to types only:
```ts
import {
  type AdminPack,
  type AdminPackWrite,
} from '../../lib/packs-api';
```
Change line 26:
```ts
import { uploadImage, deletePack } from '../../lib/admin-rest';
```
to:
```ts
import {
  useCreatePack,
  useDeletePack,
  usePacks,
  useUpdatePack,
  useUploadImage,
} from '../../lib/queries';
```

- [ ] **Step 2: Replace state + effect + reload**

Replace current lines 91-120:
```ts
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [packs, setPacks] = useState<AdminPack[] | null>(null);
  const [error, setError] = useState(false);
  const [mode, setMode] = useState<'create' | 'edit' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminPack | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    packsApi.admin.packs
      .query()
      .then((res) => active && setPacks(res.packs))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);

  const reload = async () => {
    try {
      const res = await packsApi.admin.packs.query();
      setPacks(res.packs);
    } catch {
      toast.error(t('packs.list.loadError'));
    }
  };
```
with:
```ts
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: packs = null, isError } = usePacks();
  const createPack = useCreatePack();
  const updatePack = useUpdatePack();
  const removePack = useDeletePack();
  const uploadImg = useUploadImage();
  const [mode, setMode] = useState<'create' | 'edit' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<AdminPack | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = uploadImg.isPending;
  const saving = createPack.isPending || updatePack.isPending;
```

- [ ] **Step 3: Rewrite `handleFile`**

Replace current lines 133-154 with:
```ts
  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side gate: instant reject before the upload round-trip. The
    // server re-validates (and is authoritative).
    const problem = await validateImageFile(file, 'pack');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const url = await uploadImg.mutateAsync({ file, kind: 'pack' });
      patch({ image: url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
```

- [ ] **Step 4: Rewrite `save` and `confirmDelete`**

Replace current lines 168-215 (`const save = …` through end of `confirmDelete`) with:
```ts
  const save = async () => {
    if (!canSave) return;
    const payload: AdminPackWrite = {
      title: form.title.trim(),
      category: form.category,
      price: Number(form.price),
      image: form.image.trim(),
      buyback_percent: Math.trunc(Number(form.buybackPercent)),
      boost: form.boost,
      rank: form.rank.trim() === '' ? 0 : Math.trunc(Number(form.rank)),
      status: form.status,
    };
    try {
      if (mode === 'create') {
        await createPack.mutateAsync({ ...payload, slug: form.slug.trim() });
        toast.success(t('packs.toast.created'));
      } else {
        await updatePack.mutateAsync({ slug: form.slug, ...payload });
        toast.success(t('packs.toast.updated'));
      }
      setMode(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const slug = deleteTarget.slug;
    setDeleteTarget(null);
    try {
      await removePack.mutateAsync(slug);
      toast.success(t('packs.toast.deleted'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
```

- [ ] **Step 5: Update list guard**

In the table conditional (current line 231): `{error ? (` → `{isError ? (`. The `packs === null` / `packs.length === 0` branches stay valid.

- [ ] **Step 6: Lint**

Run: `cd backend && corepack yarn workspace @acme/admin run lint`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add backend/apps/admin/src/routes/packs/page.tsx
git commit -m "refactor(admin): packs page uses query + mutation hooks"
```

---

## Task 6: Migrate `cards/RegisterCardModal.tsx`

**Files:**
- Modify: `backend/apps/admin/src/routes/cards/RegisterCardModal.tsx`

- [ ] **Step 1: Swap imports**

Change line 14:
```ts
import { packsApi } from "../../lib/packs-api";
```
Delete it (the register call moves to the hook).

Change the `admin-rest` import (lines 15-22) to drop `listEligibleProducts` (it moves into the hook) but keep the PriceCharting fns + types:
```ts
import {
  searchPriceCharting,
  getPriceChartingProduct,
  type EligibleProduct,
  type PcMatch,
  type PcProduct,
} from "../../lib/admin-rest";
```
Add the hook import after it:
```ts
import { useEligibleProducts, useRegisterCard } from "../../lib/queries";
```

- [ ] **Step 2: Drop the `onRegistered` prop**

Change the `Props` type (current lines 29-33):
```ts
type Props = {
  open: boolean;
  onClose: () => void;
  onRegistered: () => Promise<void> | void;
};
```
to:
```ts
type Props = {
  open: boolean;
  onClose: () => void;
};
```
Change the component signature (current line 44):
```ts
const RegisterCardModal = ({ open, onClose, onRegistered }: Props) => {
```
to:
```ts
const RegisterCardModal = ({ open, onClose }: Props) => {
```

- [ ] **Step 3: Replace the products state + register mutation wiring**

Replace current lines 47-55:
```ts
  // Product picker.
  const [products, setProducts] = useState<EligibleProduct[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState("");
  const [productId, setProductId] = useState<string | null>(null);

  // Gacha facts.
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const [saving, setSaving] = useState(false);
```
with:
```ts
  // Product picker — the eligible list is a cached query, refetched on each open.
  const { data: products = null, isError: loadError } =
    useEligibleProducts(open);
  const registerCard = useRegisterCard();
  const [filter, setFilter] = useState("");
  const [productId, setProductId] = useState<string | null>(null);

  // Gacha facts.
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const saving = registerCard.isPending;
```
Note: `EligibleProduct` is still used as a parameter type in `pick(p: EligibleProduct)` and the `visible`/`selected` memos, so keep the import.

- [ ] **Step 4: Trim the open-reset effect (it no longer manages the products query)**

Replace the effect (current lines 64-82):
```ts
  // Reset + (re)load the eligible list every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setProducts(null);
    setLoadError(false);
    setFilter("");
    setProductId(null);
    setFields(EMPTY_FIELDS);
    setPcQuery("");
    setPcMatches(null);
    setPcProduct(null);
    listEligibleProducts()
      .then((list) => active && setProducts(list))
      .catch(() => active && setLoadError(true));
    return () => {
      active = false;
    };
  }, [open]);
```
with:
```ts
  // Reset the local form state every time the dialog opens. The eligible-product
  // list is owned by useEligibleProducts(open) and refetches on its own.
  useEffect(() => {
    if (!open) return;
    setFilter("");
    setProductId(null);
    setFields(EMPTY_FIELDS);
    setPcQuery("");
    setPcMatches(null);
    setPcProduct(null);
  }, [open]);
```
(`useEffect` is still imported on line 1 alongside `useMemo`/`useState` — keep it.)

- [ ] **Step 5: Rewrite `save` to use the register mutation**

Replace current lines 150-169 (`const save = …`) with:
```ts
  const save = async () => {
    if (!canSave || !productId) return;
    try {
      await registerCard.mutateAsync({
        product_id: productId,
        set: fields.set.trim(),
        grader: fields.grader.trim(),
        grade: fields.grade.trim(),
        market_value: Number(fields.market_value),
      });
      toast.success(t("cards.toast.created"));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
```
(`canSave` already includes `!saving`; with `saving = registerCard.isPending` it now reflects the mutation.)

- [ ] **Step 6: Lint**

Run: `cd backend && corepack yarn workspace @acme/admin run lint`
Expected: exits 0. Confirm auto typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add backend/apps/admin/src/routes/cards/RegisterCardModal.tsx
git commit -m "refactor(admin): register modal uses useEligibleProducts + useRegisterCard"
```

---

## Task 7: Migrate `packs/[slug]/page.tsx` (odds editor — the delicate one)

**Files:**
- Modify: `backend/apps/admin/src/routes/packs/[slug]/page.tsx`

- [ ] **Step 1: Swap imports**

Change line 1:
```ts
import { useEffect, useMemo, useState } from 'react';
```
(keep as-is — all three hooks are still used.)

Change line 20:
```ts
import { packsApi, type AdminCard } from '../../../lib/packs-api';
```
to types only + add the OddsRow type for the mapper:
```ts
import type { AdminCard, OddsRow } from '../../../lib/packs-api';
```
Add the hook import after line 22:
```ts
import {
  useCards,
  usePackOdds,
  useSaveMembers,
  useSaveOdds,
} from '../../../lib/queries';
```

- [ ] **Step 2: Add the `mapOddsToRows` top-level helper (dedupes the two inline maps)**

Insert this directly after the `EditRow` type definition (after current line 38) and before `fmtPct`:
```ts
// Map a server odds snapshot into the editable row buffer. Used to seed the
// editor on load and to reseed after a membership change.
const mapOddsToRows = (odds: OddsRow[]): EditRow[] =>
  odds.map((o) => ({
    card_id: o.card_id,
    name: o.name,
    image: o.image,
    rarity: o.rarity,
    market_value: o.market_value,
    stock: o.stock,
    currentPct: o.pct,
    locked: o.locked,
    pctInput: String(o.pct),
  }));
```

- [ ] **Step 3: Replace the snapshot state + mount effect + reloadOdds with the query + seeding effect**

Replace current lines 48-104:
```ts
  const [packTitle, setPackTitle] = useState<string>('');
  const [packStatus, setPackStatus] = useState<string>('');
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    packsApi.admin.packs.$slug.odds
      .query({ $slug: slug })
      .then((res) => {
        if (!active) return;
        setPackTitle(res.pack.title);
        setPackStatus(res.pack.status);
        setRows(
          res.odds.map((o) => ({
            card_id: o.card_id,
            name: o.name,
            image: o.image,
            rarity: o.rarity,
            market_value: o.market_value,
            stock: o.stock,
            currentPct: o.pct,
            locked: o.locked,
            pctInput: String(o.pct),
          })),
        );
      })
      .catch(() => active && setLoadError(true));
    return () => {
      active = false;
    };
  }, [slug]);

  // Reload the pool after a membership change (no mount guard — still mounted).
  const reloadOdds = async () => {
    try {
      const res = await packsApi.admin.packs.$slug.odds.query({ $slug: slug });
      setPackTitle(res.pack.title);
      setPackStatus(res.pack.status);
      setRows(
        res.odds.map((o) => ({
          card_id: o.card_id,
          name: o.name,
          image: o.image,
          rarity: o.rarity,
          market_value: o.market_value,
          stock: o.stock,
          currentPct: o.pct,
          locked: o.locked,
          pctInput: String(o.pct),
        })),
      );
    } catch {
      toast.error(t('packs.editor.loadError'));
    }
  };
```
with:
```ts
  const { data, isError: loadError } = usePackOdds(slug);
  const saveOdds = useSaveOdds();
  const saveMembersMut = useSaveMembers();
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const saving = saveOdds.isPending;
  const packTitle = data?.pack.title ?? '';
  const packStatus = data?.pack.status ?? '';

  // Seed (and reseed) the editable buffer from the server snapshot. The only
  // refetches are our explicit post-save-members invalidations (staleTime 90s,
  // no refetch-on-focus), so this never clobbers in-progress edits.
  useEffect(() => {
    if (data) setRows(mapOddsToRows(data.odds));
  }, [data]);
```

- [ ] **Step 4: Replace the pool picker state + openPool with the shared cards query**

Replace current lines 107-123:
```ts
  // Prize-pool membership — which cards belong to this pack.
  const [poolOpen, setPoolOpen] = useState(false);
  const [allCards, setAllCards] = useState<AdminCard[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [savingMembers, setSavingMembers] = useState(false);

  const openPool = async () => {
    setSelected(new Set((rows ?? []).map((r) => r.card_id)));
    setPoolOpen(true);
    if (allCards === null) {
      try {
        const res = await packsApi.admin.cards.query();
        setAllCards(res.cards);
      } catch {
        toast.error(t('packs.pool.loadError'));
      }
    }
  };
```
with:
```ts
  // Prize-pool membership — which cards belong to this pack.
  const [poolOpen, setPoolOpen] = useState(false);
  const { data: allCards = null } = useCards({ enabled: poolOpen });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const savingMembers = saveMembersMut.isPending;

  const openPool = () => {
    setSelected(new Set((rows ?? []).map((r) => r.card_id)));
    setPoolOpen(true);
  };
```
(`AdminCard` is still referenced by the `useCards` result rendering in the pool modal — but only as inferred type. It is no longer used explicitly, so if TypeScript/ESLint flags `AdminCard` as an unused import, remove it from the Step 1 import, leaving `import type { OddsRow } from '../../../lib/packs-api';`. Verify in Step 8.)

- [ ] **Step 5: Rewrite `saveMembers` to use the mutation**

Replace current lines 133-150 (`const saveMembers = …`) with:
```ts
  const saveMembers = async () => {
    try {
      const res = await saveMembersMut.mutateAsync({
        slug,
        card_ids: Array.from(selected),
      });
      toast.success(
        t('packs.pool.saved', { added: res.added, removed: res.removed }),
      );
      setPoolOpen(false);
      // Invalidation (in the hook) refetches the odds → the seeding effect reseeds.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
```

- [ ] **Step 6: Rewrite `save` (odds) to use the mutation, keeping the response-patch**

Replace current lines 190-226 (`async function save() { … }`) with:
```ts
  async function save() {
    if (!rows || result.error || saving) return;
    try {
      const entries: OddsInput[] = rows.map((r) => ({
        card_id: r.card_id,
        locked: r.locked,
        pct: Number(r.pctInput),
        rarity: r.rarity,
      }));
      const res = await saveOdds.mutateAsync({ slug, entries });
      const byId = new Map(res.odds.map((c) => [c.card_id, c]));
      setRows(
        (prev) =>
          prev?.map((r) => {
            const c = byId.get(r.card_id);
            return c
              ? {
                  ...r,
                  currentPct: c.pct,
                  locked: c.locked,
                  pctInput: String(c.pct),
                }
              : r;
          }) ?? null,
      );
      toast.success(t('packs.editor.saved'));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(message);
    }
  }
```
(Identical body to today minus the `setSaving` calls — the lock-save path is unchanged. `data` is NOT invalidated here, so the seeding effect does not re-run and the patched rows stand.)

- [ ] **Step 7: Verify the JSX still references the right names**

No JSX changes needed — `packTitle`, `packStatus`, `rows`, `loadError`, `saving`, `savingMembers`, `allCards`, `openPool`, `saveMembers`, `save` all keep their names. Confirm the early return `if (loadError)` (current line 228) still compiles (`loadError` is now `isError` from the query, aliased in Step 3).

- [ ] **Step 8: Lint**

Run: `cd backend && corepack yarn workspace @acme/admin run lint`
Expected: exits 0. If `AdminCard` is reported unused, apply the Step 4 note (drop it from the import).

- [ ] **Step 9: Commit**

```bash
git add backend/apps/admin/src/routes/packs/[slug]/page.tsx
git commit -m "refactor(admin): odds editor uses usePackOdds; remove unguarded reloadOdds"
```

---

## Task 8: Migrate `support/page.tsx` (partial — view + adjust)

**Files:**
- Modify: `backend/apps/admin/src/routes/support/page.tsx`

- [ ] **Step 1: Swap imports**

Change the `admin-rest` import (lines 18-24) to keep `searchCustomers` (still imperative) + types, dropping `adjustCustomerCredits`/`getCustomerGacha` (now in hooks):
```ts
import {
  searchCustomers,
  type CustomerGacha,
  type SupportCustomer,
} from "../../lib/admin-rest";
```
Add the hook import after it:
```ts
import { useAdjustCredits, useCustomerGacha } from "../../lib/queries";
```
(`CustomerGacha` type stays used? After refactor `view` comes from the query as `CustomerGacha | undefined`; the explicit `CustomerGacha` annotation is removed, so `CustomerGacha` may become unused — if ESLint flags it, drop it from the import. Verify in Step 6.)

- [ ] **Step 2: Replace the `view`/`loadingView` state with `selectedId` + the query**

Replace current lines 38-43:
```ts
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SupportCustomer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState<CustomerGacha | null>(null);
  const [loadingView, setLoadingView] = useState(false);
```
with:
```ts
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SupportCustomer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: view } = useCustomerGacha(selectedId);
  const adjustCredits = useAdjustCredits();
```

- [ ] **Step 3: Update the adjust-form state line**

Current line 48 `const [adjusting, setAdjusting] = useState(false);` → replace with:
```ts
  const adjusting = adjustCredits.isPending;
```

- [ ] **Step 4: Rewrite `search`, `open`, `requestAdjust`, `applyAdjust`**

Replace current lines 53-116 (`const search = …` through the end of `applyAdjust`) with:
```ts
  const search = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSelectedId(null);
    try {
      setResults(await searchCustomers(q));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const open = (id: string) => {
    setSelectedId(id);
    setAmount("");
    setNote("");
  };

  // Validate, then ask for confirmation — the actual mutation runs in
  // applyAdjust once the Prompt is accepted.
  const requestAdjust = () => {
    if (!view || adjusting) return;
    const value = Number(amount);
    if (!Number.isFinite(value)) {
      toast.error(t("support.adjustInvalid"));
      return;
    }
    setConfirmOpen(true);
  };

  const applyAdjust = async () => {
    if (!view || adjusting) return;
    const value = Number(amount);
    setConfirmOpen(false);
    try {
      const res = await adjustCredits.mutateAsync({
        id: view.customer.id,
        amount: value,
        note,
      });
      toast.success(
        t("support.adjusted", {
          amount: usd(res.amount),
          balance: usd(res.balance),
        }),
      );
      // Invalidation (in the hook) refetches the customer view → fresh ledger row.
      setAmount("");
      setNote("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
```

- [ ] **Step 5: Update the JSX references from `view`-set to `selectedId`**

- The results list guard (current line 144) `{results !== null && !view && (` — stays valid (`view` is `undefined` when no selection, `!view` is `true`).
- The row onClick (current line 159) `onClick={() => open(c.id)}` — stays.
- The "back" button (current line 194) `onClick={() => setView(null)}` → `onClick={() => setSelectedId(null)}`.

(All other `view.*` reads stay — `view` is now `CustomerGacha | undefined`, guarded by the `{view && (` block at current line 177.)

- [ ] **Step 6: Lint**

Run: `cd backend && corepack yarn workspace @acme/admin run lint`
Expected: exits 0. If `CustomerGacha` is flagged unused, drop it from the Step 1 import.

- [ ] **Step 7: Commit**

```bash
git add backend/apps/admin/src/routes/support/page.tsx
git commit -m "refactor(admin): support view uses useCustomerGacha + useAdjustCredits"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full workspace build**

Run: `cd backend && corepack yarn build`
Expected: turbo builds all packages (incl. `@acme/odds-math` dist first via `^build`) and `@acme/admin` (`tsc -b && vite build`) with exit 0. No type errors.

- [ ] **Step 2: Admin lint**

Run: `cd backend && corepack yarn workspace @acme/admin run lint`
Expected: exits 0.

- [ ] **Step 3: Confirm `reloadOdds` is gone and no `packsApi` direct calls remain in route pages**

Run a grep to prove the pattern was removed:
```bash
git grep -n "reloadOdds\|let active = true" backend/apps/admin/src/routes
```
Expected: no matches.

- [ ] **Step 4 (optional, needs services): admin smoke**

If the 4 services are up (storefront/backend/admin + infra), open the admin dashboard, and for the odds editor specifically: open a pack, toggle a lock, set a win rate, save, reload → confirm the lock + % persisted. Otherwise record this as a manual follow-up in the PR description.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin refactor/admin-react-query-seam
gh pr create --fill --base master
```
Then run CodeRabbit review from the real checkout (not a worktree).

---

## Self-review (completed during planning)

- **Spec coverage:** seam module (Task 1) ✓; all 5 mount-load pages + register modal + partial support (Tasks 2-8) ✓; lock-path tightening — `useSaveOdds` has no invalidation + page keeps response-patch (Task 1 + Task 7 Step 6) ✓; out-of-scope `usd`/`fmtPct`/`timeAgo` untouched ✓; verification via build+lint (Task 9) ✓.
- **Placeholder scan:** none — every step shows the actual code/command.
- **Type consistency:** `qk` keys, hook names (`usePacks`/`useCards`/`usePulls`/`useEconomy`/`usePackOdds`/`useEligibleProducts`/`useCustomerGacha`/`useUpdateCard`/`useDeleteCard`/`useRegisterCard`/`useCreatePack`/`useUpdatePack`/`useDeletePack`/`useSaveOdds`/`useSaveMembers`/`useAdjustCredits`/`useUploadImage`), and mutation var names are consistent across the seam and the page tasks. `mapOddsToRows(odds: OddsRow[])` matches `data.odds` (typed `OddsRow[]`).
- **Known lint follow-ups flagged inline:** possibly-unused type imports (`AdminCard` in `[slug]`, `CustomerGacha` in support, `EconomyReport` in economy) — each task says to drop it if ESLint flags it.
