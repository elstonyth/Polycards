'use client';

import Link from 'next/link';
import { Minus, Play, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import {
  FLAT_BUYBACK_PERCENT,
  FREE_PULL_LOCKED_MESSAGE,
} from '@/lib/packs-data';
import { Pill } from '@/components/ui/pill';
import { ArrowDisc, SPRING } from '@/components/ui/soft';
import type { PackBuyModel } from './use-pack-buy';

/**
 * Shown where the gift offer would be, when this visitor cannot claim it.
 *
 * DELIBERATELY does not say "already claimed". The ineligible state is
 * `canClaimFreePack` false, which covers a spent claim AND a failed
 * eligibility read (backend down, breaker open): the storefront cannot tell
 * them apart, so any wording asserting a past claim is a lie to a first-time
 * visitor whose read simply failed. This sentence is true in both.
 *
 * Storefront-only copy (unlike FREE_PULL_LOCKED_MESSAGE, which the backend also
 * throws): nothing server-side refuses with this wording.
 */
export const FREE_PACK_UNAVAILABLE_MESSAGE =
  "This welcome pack isn't available on this account.";

export type PackBuyVariant = 'dock' | 'panel';

/**
 * The pack's buy controls, in the two places they sit:
 * - `panel`: the desktop configurator's two lower zones (terms + demo spin +
 *   quantity, then the Open footer). A fragment: the caller's panel puts the
 *   pack picker above it, and on a phone the terms zone moves above that
 *   (`order-first`), so both zones must be the panel's own children.
 * - `dock`: the phone's fixed buy bar above the tab bar.
 * All read one `usePackBuy` model, so they can never disagree.
 */
export function PackBuyControls({
  model,
  variant,
}: {
  model: PackBuyModel;
  variant: PackBuyVariant;
}) {
  if (variant === 'dock') return <BuyDock m={model} />;
  return <BuyPanel m={model} />;
}

/** The open's refusal, with the way out of it (Settings link or top-up). */
function OpenError({ m }: { m: PackBuyModel }) {
  if (!m.openError) return null;
  return (
    <p role="alert" className="mt-2 text-center text-xs text-red-300">
      {m.openError}
      {m.needsVerify && (
        <>
          {' '}
          <Link
            href={m.verifyLink.href}
            className="font-bold text-white underline underline-offset-2"
          >
            {m.verifyLink.label}
          </Link>
        </>
      )}
      {m.needsTopUp && (
        <>
          {' '}
          {m.balance !== null && m.paidCost - m.balance > 0 && (
            <>You&apos;re {rm(m.paidCost - m.balance)} short. </>
          )}
          <button
            type="button"
            onClick={m.openTopUp}
            className="font-bold text-buyback-fg underline underline-offset-2 hover:text-buyback-fg"
          >
            Top up credits →
          </button>
        </>
      )}
    </p>
  );
}

const PANEL_STEP =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-neutral-300 outline-none ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-white/40 transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-white/10 hover:text-white active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-[background-color,color] motion-reduce:active:scale-100';

const DOCK_STEP =
  'flex h-11 w-9 items-center justify-center rounded-full text-neutral-300 outline-none max-[359px]:w-8 focus-visible:ring-2 focus-visible:ring-white/40 transition-[color,transform] hover:text-white active:scale-[0.92] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-colors motion-reduce:active:scale-100';

function BuyPanel({ m }: { m: PackBuyModel }) {
  const { showExplainer, showDemo, showQty, qty, maxQty, setQ, Noun } = m;
  return (
    <>
      <div
        className={cn(
          // Phones read the terms and the guest demo spin BEFORE the
          // picker, as they did before the redesign: under it the demo
          // sat a screen further down. Desktop reads choose, terms, open.
          'order-first flex-col gap-3.5 border-b border-white/10 px-4 py-3 sm:px-5 lg:order-none lg:border-b-0 lg:border-t',
          // The quantity row is lg-only (phones step in the buy dock), so
          // with nothing else to say this zone has no phone rendering.
          showExplainer || showDemo
            ? 'flex'
            : showQty
              ? 'hidden lg:flex'
              : 'hidden',
        )}
      >
        {showExplainer && (
          <p className="text-[13px] leading-relaxed text-neutral-400">
            The pack rate applies during the reveal countdown. Leaving the
            reveal or letting the timer expire changes buyback to{' '}
            {FLAT_BUYBACK_PERCENT}% of card value in your vault.
          </p>
        )}

        {/* Free demo spin: guests only (a real account opens real packs).
            Routes to the slot reel in demo mode: no login, no charge,
            nothing real won. Neutral ghost styling: buyback green is
            reserved for money-in actions. */}
        {showDemo && (
          <Link
            href={m.demoHref}
            className={cn(
              'group flex min-h-12 items-center justify-between rounded-full bg-white/[0.06] py-1.5 pl-2 pr-1.5 text-sm font-semibold text-white outline-none ring-1 ring-white/10 transition-[background-color,transform] duration-300',
              SPRING,
              'hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40 active:scale-[0.99] motion-reduce:transition-[background-color] motion-reduce:active:scale-100',
            )}
          >
            <span className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white">
                <Play className="ml-0.5 h-3.5 w-3.5 fill-current" aria-hidden />
              </span>
              <span className="flex flex-col leading-tight">
                Try a free demo spin
                <span className="text-xs font-normal text-neutral-400">
                  No login · nothing charged
                </span>
              </span>
            </span>
            <ArrowDisc className="bg-white/10 group-hover:-translate-y-px group-hover:translate-x-0.5 group-hover:scale-105 motion-reduce:group-hover:transform-none" />
          </Link>
        )}

        {/* Quantity: desktop only; on phones it lives in the sticky buy bar
            so there is a single Open control per zone. Absent on the free
            pack: the claim buys exactly one open. */}
        <div className={cn('hidden items-center gap-2', showQty && 'lg:flex')}>
          <button
            type="button"
            aria-label="Decrease quantity"
            onClick={() => setQ(qty - 1)}
            disabled={qty <= 1}
            className={PANEL_STEP}
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          <span className="flex h-11 flex-1 items-center justify-center rounded-full bg-white/[0.06] text-sm font-semibold tabular-nums text-white ring-1 ring-white/10">
            {qty} {qty === 1 ? Noun : `${Noun}s`}
          </span>
          <button
            type="button"
            aria-label="Increase quantity"
            onClick={() => setQ(qty + 1)}
            disabled={qty >= maxQty}
            className={PANEL_STEP}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setQ(maxQty)}
            className="flex h-11 px-3 text-xs font-bold uppercase tracking-wide shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-neutral-400 outline-none ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-white/40 transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-white/10 hover:text-white active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-[background-color,color] motion-reduce:active:scale-100"
          >
            Max
          </button>
        </div>
      </div>

      {/* Open: desktop panel footer (phones use the sticky bar). Pinned to
          the panel's bottom edge, so it stays in view if the panel has to
          scroll. */}
      <div className="hidden border-t border-white/10 bg-neutral-950 px-4 py-3 lg:sticky lg:bottom-0 lg:block">
        {/* DESIGN.md primary: Paper White pill, Ink text. Absent when the
            claim is unavailable: the open would 4xx. */}
        {m.soldOut ? (
          <Pill variant="secondary" size="lg" disabled className="w-full">
            {m.unavailableLabel}
          </Pill>
        ) : (
          !m.freeClaimUnavailable && (
            <Pill
              variant="primary"
              size="lg"
              onClick={m.handleGoToReel}
              className="group/open w-full justify-between pl-6 pr-2"
            >
              {m.signedIn
                ? m.isFreePack
                  ? 'Open Free Pack'
                  : m.openLabel
                : 'Log in to open'}
              <span className="flex items-center gap-2.5 font-heading text-base tracking-tight tabular-nums">
                {!m.isFreePack && (m.vaultCost ?? rm(m.priceNum * qty))}
                <ArrowDisc className="group-hover/open:-translate-y-px group-hover/open:translate-x-0.5 group-hover/open:scale-105 motion-reduce:group-hover/open:transform-none" />
              </span>
            </Pill>
          )
        )}
        <OpenError m={m} />
        <p
          className={cn(
            'text-center text-xs text-neutral-400',
            !m.freeClaimUnavailable && 'mt-2',
          )}
        >
          <PanelCaption m={m} />
        </p>
      </div>
    </>
  );
}

function PanelCaption({ m }: { m: PackBuyModel }) {
  if (m.freeClaimUnavailable) return <>{FREE_PACK_UNAVAILABLE_MESSAGE}</>;
  if (m.isFreePack)
    return (
      <>
        Your one-time welcome pack — nothing charged. The card lands in your
        vault. {FREE_PULL_LOCKED_MESSAGE}
      </>
    );
  if (m.previewOnly) return <>Draft card packs can be viewed but not opened.</>;
  if (m.soldOut) return <>This {m.noun} is sold out right now.</>;
  if (m.signedIn && m.balance !== null)
    return (
      <>
        Each open costs {rm(m.priceNum)} from your balance — you have{' '}
        <span
          className={cn(
            'font-bold',
            m.balance < m.priceNum ? 'text-red-300' : 'text-neutral-200',
          )}
        >
          {rm(m.balance)}
        </span>
      </>
    );
  return (
    <>
      Each open costs the {m.noun} price from your balance — one {m.noun} per
      open, recorded to your account.
    </>
  );
}

/** The big figure on the dock. */
const totalLine = (m: PackBuyModel) =>
  m.freeClaimUnavailable
    ? 'Unavailable'
    : m.isFreePack
      ? 'Free'
      : // A vault pack: the long "Vault x1 + RM 300.00" line would truncate
        // here, so the gifts take the big line and the paid rows the small one.
        m.vaultGifts > 0
        ? `Vault x${m.vaultGifts}`
        : rm(m.priceNum * m.qty);

/** The small line under it. */
const termsLine = (m: PackBuyModel) =>
  m.freeClaimUnavailable
    ? 'Not available on this account'
    : m.isFreePack
      ? 'Your welcome pack'
      : m.soldOut
        ? 'Not available right now'
        : m.vaultGifts > 0
          ? m.qty > m.vaultGifts
            ? `+ ${rm(m.paidCost)}`
            : 'Gift from Polycards'
          : m.ticketPack
            ? 'Lucky Draw tickets'
            : `${m.buybackPercent}% during reveal`;

/** The quiet capsule stepper of the dock. */
function DockStepper({ m }: { m: PackBuyModel }) {
  return (
    <div
      className={cn(
        'h-11 shrink-0 items-center rounded-full bg-neutral-800',
        m.isFreePack || m.soldOut ? 'hidden' : 'flex',
      )}
    >
      <button
        type="button"
        aria-label="Decrease quantity"
        onClick={() => m.setQ(m.qty - 1)}
        disabled={m.qty <= 1}
        className={DOCK_STEP}
      >
        <Minus className="h-4 w-4" aria-hidden />
      </button>
      <span className="w-4 text-center text-sm font-semibold tabular-nums text-white">
        {m.qty}
      </span>
      <button
        type="button"
        aria-label="Increase quantity"
        onClick={() => m.setQ(m.qty + 1)}
        disabled={m.qty >= m.maxQty}
        className={DOCK_STEP}
      >
        <Plus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/** The dock's single white pill (or the disabled unavailable one). */
function DockOpen({ m, className }: { m: PackBuyModel; className: string }) {
  if (m.soldOut)
    return (
      <Pill variant="secondary" size="md" disabled className="px-5">
        {m.unavailableLabel}
      </Pill>
    );
  if (m.freeClaimUnavailable) return null;
  return (
    <Pill
      variant="primary"
      size="md"
      onClick={m.handleGoToReel}
      className={className}
    >
      {m.signedIn ? (m.isFreePack ? 'Open Free Pack' : m.openLabel) : 'Log in'}
    </Pill>
  );
}

/**
 * The phone's buy bar: one slim pill floating over the tab dock, as the
 * vault's does. Total in Nekst over the terms, a quiet capsule stepper, and
 * one single-purpose white pill (the panel's own quantity and footer are
 * lg-only, so there is exactly one CTA per zone). (Owner 2026-11-26: the
 * full-width strip stood too tall once its pill took a second row.)
 */
function BuyDock({ m }: { m: PackBuyModel }) {
  return (
    <div
      data-testid="pack-buy-dock"
      // globals.css: the site footer ends above this bar.
      data-buy-bar
      className="fixed inset-x-3 bottom-[calc(max(env(safe-area-inset-bottom),0.5rem)+4.25rem)] z-40 mx-auto max-w-88 rounded-[1.75rem] border border-white/10 bg-neutral-900 p-1.5 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.9)] lg:hidden"
    >
      {/* A price is never cut short: when it can't fit beside the stepper and
          the pill, the pill takes its own row. The 999 hands the spare width
          of a single row to this block, so the pill only grows once alone. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <div className="min-w-min flex-[999_1_0%] pl-2.5">
          {/* Free mode states the gift where the total normally sits: the
              slot must not go empty, or the pill drifts left. */}
          <p className="whitespace-nowrap font-heading text-[clamp(0.8125rem,4.2vw,1.125rem)] font-bold leading-none tracking-tight text-white tabular-nums">
            {totalLine(m)}
          </p>
          {/* w-0 min-w-full: the terms never widen the block, they are cut. */}
          <p className="mt-1 w-0 min-w-full truncate text-[11px] leading-none text-neutral-400">
            {termsLine(m)}
          </p>
        </div>
        <DockStepper m={m} />
        <DockOpen m={m} className="shrink-0 grow px-4 max-[359px]:px-3" />
      </div>
      <OpenError m={m} />
    </div>
  );
}
