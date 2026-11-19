'use client';

import { usePathname } from 'next/navigation';
import {
  BONE,
  PageTitle,
  SKELETON_REVEAL,
  SkeletonReveal,
} from '@/components/ui/page-frame';
import { cn } from '@/lib/utils';

// The (account) route group's loading fallback, shaped per destination. One
// switch on the pathname rather than a loading.tsx per folder: a
// vault/loading.tsx would also wrap /vault/coin-flip, and prefetch stops at
// the outermost loading boundary anyway. Each shape puts the page's real
// title text exactly where the page puts it (same component, same wrappers,
// not animated); only the blocks under it fade in, after 150ms.
//
// Sizes come from the pages themselves: VaultTabs, VaultClient's stat strip,
// tickets row, search and slab tile; vault/history's rows; LuckyDrawClient's
// title row; MeHeader and me/page.tsx's cards; CoinFlipClient's header and
// stage. Optional blocks (the Vault gifts row, Me's showcase, a draw's event
// line) get none.

export type AccountSkeletonKind =
  | 'vault'
  | 'vault-history'
  | 'lucky-draw'
  | 'me'
  | 'coin-flip'
  | 'generic';

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Which skeleton a destination gets. Pure, so a per-folder loading.tsx can
 *  pass its kind straight in if the pathname ever proves stale here. */
export function accountSkeletonKind(pathname: string): AccountSkeletonKind {
  if (under(pathname, '/vault/coin-flip')) return 'coin-flip';
  if (under(pathname, '/vault/history')) return 'vault-history';
  if (pathname === '/vault') return 'vault';
  if (under(pathname, '/lucky-draw')) return 'lucky-draw';
  if (pathname === '/me') return 'me';
  return 'generic';
}

export function AccountSkeleton({ kind }: { kind?: AccountSkeletonKind }) {
  const pathname = usePathname();
  const shape = kind ?? accountSkeletonKind(pathname ?? '');
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading</span>
      {shape === 'vault' ? (
        <VaultSkeleton />
      ) : shape === 'vault-history' ? (
        <VaultHistorySkeleton />
      ) : shape === 'lucky-draw' ? (
        <LuckyDrawSkeleton />
      ) : shape === 'me' ? (
        <MeSkeleton />
      ) : shape === 'coin-flip' ? (
        <CoinFlipSkeleton />
      ) : (
        <GenericSkeleton />
      )}
    </div>
  );
}

/** AccountHeader with its real title and the subtitle as a bone. */
function HeaderSkeleton({ title }: { title: string }) {
  return (
    <header className="mb-6">
      <PageTitle as="p">{title}</PageTitle>
      <div className={cn(SKELETON_REVEAL, 'mt-1.5 flex h-5 items-center')}>
        <div className={cn(BONE.pulse, BONE.line, 'h-4 w-64 max-w-full')} />
      </div>
    </header>
  );
}

/** VaultTabs: two 44px links + p-1 + border, mb-4. */
const VAULT_TABS = cn(BONE.track, 'mb-4 h-[54px] sm:max-w-sm');

export function VaultSkeleton() {
  return (
    <>
      <HeaderSkeleton title="Vault" />
      <SkeletonReveal>
        <div className={BONE.pulse}>
          <div className={VAULT_TABS} />

          {/* Stat strip: py-4, an 11px label over a 13/16/18px value. */}
          <div className="grid h-[72px] grid-cols-3 divide-x divide-white/10 rounded-2xl border border-white/10 bg-neutral-900 sm:h-[77px] lg:h-[81px]">
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="flex flex-col items-center justify-center gap-1.5 px-2"
              >
                <div className={cn(BONE.line, 'h-3 w-14')} />
                <div className={cn(BONE.bar, 'h-4 w-16')} />
              </div>
            ))}
          </div>

          {/* Lucky Draw tickets row: buttons wrap under the art on a phone. */}
          <div className={cn(BONE.panel, 'mt-4 h-[123px] sm:h-[71px]')} />

          {/* Search field */}
          <div className="mt-4 h-11 rounded-xl bg-neutral-800" />

          {/* Slab grid: 3-up, 4-up from lg; tile = slab + two text rows. */}
          <div className="mt-5 grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-4">
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="rounded-2xl border border-white/10 bg-neutral-900 p-2 sm:p-3"
              >
                <div className="aspect-[16/27] rounded-lg bg-white/[0.04]" />
                <div className="mt-1.5 flex h-[1.9rem] items-start sm:mt-2 sm:h-[2.1rem]">
                  <div className={cn(BONE.line, 'mt-1 h-3 w-4/5')} />
                </div>
                <div className={cn(BONE.line, 'mt-1 h-3 w-1/2')} />
              </div>
            ))}
          </div>
        </div>
      </SkeletonReveal>
    </>
  );
}

export function VaultHistorySkeleton() {
  return (
    <>
      <HeaderSkeleton title="Vault" />
      <SkeletonReveal>
        <div className={BONE.pulse}>
          <div className={VAULT_TABS} />
          {/* Pull rows: a slab thumb beside the name, pack, date, figures. */}
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div
                key={i}
                className="flex gap-3 rounded-2xl border border-white/10 bg-neutral-900 p-3"
              >
                <div className="aspect-[16/27] w-14 shrink-0 rounded-lg bg-white/[0.04] sm:w-16" />
                <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                  <div className={cn(BONE.bar, 'h-3.5 w-3/5')} />
                  <div className={cn(BONE.line, 'h-3 w-2/5')} />
                  <div className={cn(BONE.line, 'h-3 w-1/3')} />
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {Array.from({ length: 3 }, (_, j) => (
                      <div key={j} className={cn(BONE.line, 'h-7')} />
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </SkeletonReveal>
    </>
  );
}

export function LuckyDrawSkeleton() {
  return (
    // The same breakout as the page, so the stage does not jump wide.
    <div className="pool-wide">
      {/* LuckyDrawClient's title row, class for class: the title, the ticket
          chip (36px) and the three-way pill, with Draw's squat/short spacing. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-4 squat:-mt-3 squat:gap-y-2 short:-mt-3 lg:gap-x-6">
        <div className="min-w-0">
          <PageTitle as="p" className="whitespace-nowrap short:text-xl">
            LUCKY DRAW
          </PageTitle>
        </div>
        <div
          className={cn(
            SKELETON_REVEAL,
            'h-9 w-20 shrink-0 short:order-last lg:order-last',
          )}
        >
          <div
            className={cn(BONE.pulse, 'h-full rounded-full bg-neutral-800')}
          />
        </div>
        <div
          className={cn(
            SKELETON_REVEAL,
            'w-full short:w-[clamp(15rem,40vw,20rem)] lg:w-[26rem]',
          )}
        >
          {/* 44/40/36px buttons + p-1 + border. */}
          <div
            className={cn(
              BONE.pulse,
              BONE.track,
              'h-[54px] squat:h-[50px] short:h-[46px]',
            )}
          />
        </div>
      </div>

      {/* One gate ticket. An estimate: the stub art's height (GateList
          ART_HEIGHT) plus about 15rem for the stub's text and action. */}
      <SkeletonReveal className="mt-4 squat:mt-3 short:mt-3">
        <div
          className={cn(
            BONE.pulse,
            BONE.panel,
            'h-[calc(clamp(5rem,15dvh,8rem)_+_15rem)] rounded-[20px] sm:h-[calc(clamp(8rem,20dvh,11rem)_+_15rem)]',
          )}
        />
      </SkeletonReveal>
    </div>
  );
}

export function MeSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <PageTitle as="p">Me</PageTitle>
      <SkeletonReveal>
        <div className={cn(BONE.pulse, 'flex flex-col gap-4')}>
          {/* MeHeader: the 72px avatar beside the name (44px), pulls line
              and the 44px handle chip. */}
          <div className="flex items-center gap-4">
            <div className="h-[72px] w-[72px] shrink-0 rounded-full bg-white/10" />
            <div className="min-w-0">
              <div className="flex h-11 items-center">
                <div className={cn(BONE.bar, 'h-6 w-40')} />
              </div>
              <div className="mt-1 flex h-5 items-center">
                <div className={cn(BONE.line, 'h-3 w-16')} />
              </div>
              <div className="mt-1.5 h-11 w-28 rounded-full border border-white/10 bg-white/5" />
            </div>
          </div>

          {/* Level card: LV, the bar, its two labels, the next-level line. */}
          <div className={cn(BONE.panel, 'h-[105px]')} />

          {/* Balance bar */}
          <div className={cn(BONE.panel, 'h-[86px]')} />

          {/* Quick access: label, then 3x3 tiles. */}
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-5">
            <div className="flex h-[18px] items-center">
              <div className={cn(BONE.line, 'h-3 w-24')} />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-y-5">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="flex flex-col items-center gap-1.5">
                  <div className="h-11 w-11 rounded-2xl bg-neutral-800" />
                  <div className="flex h-[16.5px] items-center">
                    <div className={cn(BONE.line, 'h-2.5 w-12')} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </SkeletonReveal>
    </div>
  );
}

export function CoinFlipSkeleton() {
  return (
    <>
      {/* CoinFlipClient's header: title and line, the Vault link right. */}
      <header className="mb-4 flex items-end justify-between gap-4 sm:mb-6">
        <div className="min-w-0">
          <PageTitle as="p" className="text-balance">
            Coin flip
          </PageTitle>
          <div className={cn(SKELETON_REVEAL, 'mt-1 flex h-5 items-center')}>
            <div
              className={cn(BONE.pulse, BONE.line, 'h-3.5 w-52 max-w-full')}
            />
          </div>
        </div>
        <div className={cn(SKELETON_REVEAL, 'h-11 w-20 shrink-0')}>
          <div className={cn(BONE.pulse, BONE.line, 'mt-3.5 h-4 w-full')} />
        </div>
      </header>
      {/* The stage at its fixed toss height, the side panel from lg. */}
      <SkeletonReveal>
        <div
          className={cn(
            BONE.pulse,
            'grid overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 lg:grid-cols-[minmax(0,1fr)_288px]',
          )}
        >
          <div className="h-[clamp(220px,34svh,320px)] lg:h-[440px]" />
          <div className="h-40 border-t border-white/10 lg:h-auto lg:border-t-0 lg:border-l" />
        </div>
      </SkeletonReveal>
    </>
  );
}

/** Every other account page: AccountHeader (title unknown here, so a bar of
 *  the title's exact height) over stacked panels. */
export function GenericSkeleton() {
  return (
    <SkeletonReveal>
      <div className={BONE.pulse}>
        <header className="mb-6">
          <div
            className={cn(BONE.bar, 'h-[clamp(1.35rem,8vw,1.875rem)] w-44')}
          />
          <div className="mt-1.5 flex h-5 items-center">
            <div className={cn(BONE.line, 'h-4 w-64 max-w-full')} />
          </div>
        </header>
        <div className="flex flex-col gap-3">
          <div className={cn(BONE.panel, 'h-40')} />
          <div className={cn(BONE.panel, 'h-28')} />
          <div className={cn(BONE.panel, 'h-28')} />
        </div>
      </div>
    </SkeletonReveal>
  );
}
