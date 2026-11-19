'use client';

import { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { affordable } from '@/lib/format';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { usePackGifts } from '@/lib/use-pack-gifts';
import type { PackDetail } from '@/lib/data/packs';
import {
  FLAT_BUYBACK_PERCENT,
  FREE_WELCOME_CATEGORY,
  freePackVerifyLink,
  freePackVerifyMessage,
  isTicketPack,
  type FreePackRequirement,
  type ResolvedPack,
} from '@/lib/packs-data';
import {
  giftsUsed,
  paidCost as costAfterGifts,
  vaultButtonLabel,
  vaultCostLabel,
} from '@/lib/vault-packs';

/**
 * Everything the pack's buy controls know and do, lifted out of the pack page
 * (PackDetailClient) unchanged so the homepage flow can drive the same
 * controls: quantity, vault gifts, balance, sold out / preview only, the free
 * pack's verification prompt, the credit shortfall, and the trip to the reel.
 *
 * Call it ONCE per page and hand the model to every PackBuyControls on it:
 * two calls would read the gifts twice and keep two error states.
 *
 * The address owns the quantity (`?count=`), read straight from `location`
 * (never Next's search-params hook, which the flow's cached route cannot use):
 * Back can restore a cached server snapshot with an older `initialQty`, so the
 * live URL wins over the prop.
 */

/** Optional page-only inputs. The homepage flow needs none of them: it never
 *  shows the free pack, and its quantity starts from the address too. */
export interface PackBuyOptions {
  /** Clamped 1-3 from the URL's `?count=`, as the server read it: what renders
   *  before the browser's own address can be read. */
  initialQty?: number;
  /** Free pack ONLY: may this visitor still claim it? See PackDetailClient. */
  freePackEligible?: boolean;
  /** Free pack ONLY: what the account must still do before it can open. */
  freePackMissing?: FreePackRequirement[];
  /** The reel seam (plan step 2, section 1; the cinematic hand-off is on
   *  hold): when given, Open hands the reel address here instead of
   *  navigating itself. Absent, Open navigates as it always has. */
  onGoToReel?: (href: string) => void;
}

export interface PackBuyModel {
  pack: ResolvedPack;
  /** A signed-in customer (labels say "Open", not "Log in"). */
  signedIn: boolean;
  /** Credit balance; null = logged out or still loading. */
  balance: number | null;
  openTopUp: () => void;
  isFreePack: boolean;
  /** The free pack, reached by someone who cannot claim it. */
  freeClaimUnavailable: boolean;
  ticketPack: boolean;
  /** 'capsule' | 'pack', and capitalised. */
  noun: string;
  Noun: string;
  priceNum: number;
  /** Buyback percent the page states (the flat rate when the pack sets none). */
  buybackPercent: number;
  /** A Draft card pack: viewable, never openable. */
  previewOnly: boolean;
  unavailableLabel: string;
  /** Nothing this customer holds covers the open: no buy controls. */
  soldOut: boolean;
  qty: number;
  maxQty: number;
  setQ: (n: number) => void;
  vaultGifts: number;
  paidCost: number;
  /** "Vault x1 + RM 300.00", or null with no gift applied. */
  vaultCost: string | null;
  openLabel: string;
  openError: string | null;
  needsTopUp: boolean;
  needsVerify: boolean;
  verifyLink: { href: string; label: string };
  showExplainer: boolean;
  showDemo: boolean;
  showQty: boolean;
  demoHref: string;
  handleGoToReel: () => void;
}

// --- The address's quantity ---------------------------------------------------

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}
const readCount = (): string | null =>
  new URLSearchParams(window.location.search).get('count');
const serverCount = (): string | null => null;

/** The raw `?count=` value; null before the browser's address can be read. */
const useAddressCount = (): string | null =>
  useSyncExternalStore(subscribe, readCount, serverCount);

export function usePackBuy(
  pack: ResolvedPack,
  detail: PackDetail | null,
  {
    initialQty = 1,
    freePackEligible = true,
    freePackMissing = [],
    onGoToReel,
  }: PackBuyOptions = {},
): PackBuyModel {
  const { customer } = useAuth();
  const { balance, openTopUp } = useTopUp();
  const router = useRouter();
  const raw = useAddressCount();
  const count = Number(raw ?? initialQty);

  // A free pack still waiting on verification (spec 2026-10-06) renders with
  // the prompt already showing, so the customer reads what is left BEFORE
  // tapping a CTA that cannot succeed yet. The tap answers with it again.
  const verifyPrompt =
    pack.categoryId === FREE_WELCOME_CATEGORY && freePackMissing.length > 0
      ? freePackVerifyMessage(freePackMissing)
      : null;
  const [openError, setOpenError] = useState<string | null>(verifyPrompt);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [needsVerify, setNeedsVerify] = useState(verifyPrompt !== null);
  const verifyLink = freePackVerifyLink(freePackMissing);
  // A new pack starts clean, as a new page used to: no message about the last
  // pack's balance or verification.
  const [stateFor, setStateFor] = useState(pack.id);
  if (stateFor !== pack.id) {
    setStateFor(pack.id);
    setOpenError(verifyPrompt);
    setNeedsTopUp(false);
    setNeedsVerify(verifyPrompt !== null);
  }

  // The one-time free welcome pack: no price, no quantity, no batch.
  const isFreePack = pack.categoryId === FREE_WELCOME_CATEGORY;
  const ticketPack = isTicketPack(pack);
  const noun = ticketPack ? 'capsule' : 'pack';
  const Noun = ticketPack ? 'Capsule' : 'Pack';
  const freeClaimUnavailable = isFreePack && !freePackEligible;
  // Real backend price, never re-parsed from the rounded display string.
  const priceNum = pack.priceMyr;

  // Vault packs apply themselves here, read after mount and only when signed
  // in. Still reading (pending) or unread (failed): the price may yet drop to
  // a gift, so no credit refusal here (the reel re-checks before any charge).
  const {
    held,
    pending: giftsPending,
    failed: giftsFailed,
  } = usePackGifts(isFreePack ? null : (customer?.id ?? null), pack.id);
  // Sold out (admin): only vault gifts may still open it. A Draft card pack
  // can be looked at but not opened; a Draft capsule can be spun.
  const previewOnly = pack.draft === true && !ticketPack;
  const soldOutPack = pack.inStock === false || previewOnly;
  const unavailableLabel = previewOnly ? 'Preview only' : 'Sold out';
  // The reel (openBatch) caps a single open at 3 packs.
  const maxQty = soldOutPack ? Math.min(3, Math.max(1, held)) : 3;
  const qty = Number.isInteger(count)
    ? Math.min(maxQty, Math.max(1, count))
    : 1;
  // Gifts cover rows first; only the rest is paid (gifts -> bonus -> normal).
  const vaultGifts = giftsUsed(qty, held);
  const paidCost = costAfterGifts(priceNum, qty, held);
  const vaultCost = vaultCostLabel(qty, vaultGifts, priceNum);
  const openLabel = vaultButtonLabel(qty, vaultGifts) ?? `Open ${Noun}`;
  const soldOut = soldOutPack && vaultGifts < qty;

  const setQ = (n: number) => {
    const next = Math.min(maxQty, Math.max(1, n));
    // Replace this history entry so reload, sharing and Back from another
    // pack preserve the chosen quantity without adding an entry per tap.
    const url = new URL(window.location.href);
    url.searchParams.set('count', String(next));
    window.history.replaceState(null, '', url);
    notify();
  };

  const pool = detail?.pool ?? [];
  const showExplainer = !isFreePack && !ticketPack;
  const showDemo = !customer && pool.length > 0 && !soldOut;
  const showQty = !isFreePack && !soldOut;

  const goToReel = (href: string) => {
    if (onGoToReel) onGoToReel(href);
    else router.push(href);
  };

  // Do NOT open/charge here: navigate to the reel, which performs the single
  // charge when the lever is pulled. Auth and balance are pre-checked so the
  // customer is not dropped into the reel only to bounce. (Navigate-then-lever,
  // never auto-spin, so a reel refresh can never re-charge.)
  function handleGoToReel() {
    if (!customer) {
      openAuth('login');
      return;
    }
    // A free open costs nothing and is always singular.
    if (isFreePack) {
      setNeedsTopUp(false);
      if (verifyPrompt) {
        setOpenError(verifyPrompt);
        setNeedsVerify(true);
        return;
      }
      setOpenError(null);
      setNeedsVerify(false);
      goToReel(`/slots/${pack.id}/spin?count=1`);
      return;
    }
    if (
      !giftsPending &&
      !giftsFailed &&
      balance !== null &&
      !affordable(balance, paidCost)
    ) {
      setNeedsTopUp(true);
      setOpenError('Not enough balance to open.');
      return;
    }
    setOpenError(null);
    setNeedsTopUp(false);
    goToReel(`/slots/${pack.id}/spin?count=${qty}`);
  }

  return {
    pack,
    signedIn: Boolean(customer),
    balance,
    openTopUp,
    isFreePack,
    freeClaimUnavailable,
    ticketPack,
    noun,
    Noun,
    priceNum,
    buybackPercent: pack.buybackPercent ?? FLAT_BUYBACK_PERCENT,
    previewOnly,
    unavailableLabel,
    soldOut,
    qty,
    maxQty,
    setQ,
    vaultGifts,
    paidCost,
    vaultCost,
    openLabel,
    openError,
    needsTopUp,
    needsVerify,
    verifyLink,
    showExplainer,
    showDemo,
    showQty,
    demoHref: `/slots/${pack.id}/spin?demo=1`,
    handleGoToReel,
  };
}
