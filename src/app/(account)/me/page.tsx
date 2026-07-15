import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  Bell,
  ChevronRight,
  Download,
  LifeBuoy,
  MapPin,
  Package,
  Receipt,
  Settings,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import { getCustomer } from '@/lib/data/customer';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';
import { getOwnProfileHandle, getPublicProfile } from '@/lib/data/profiles';
import { getWallet } from '@/lib/actions/wallet';
import { getVip } from '@/lib/actions/vip';
import { getDaily } from '@/lib/actions/daily';
import { getAvatarFrames } from '@/lib/data/avatar-frames';
import { compact, rm, rm0 } from '@/lib/format';
import { SlabImage } from '@/components/SlabImage';
import { LogoutButton, TopUpButton } from './MeActions';
import { EquippedFrameProvider, FramesCard, MeHeader } from './MeAppearance';

export const metadata: Metadata = {
  title: 'Me',
  description: 'Your Polycards profile, wallet, rewards, and settings.',
};

// Quick-access grid (Show's Me pattern). VIP, Daily Box, and Withdraw tiles
// were dropped 2026-07-15: the level card, its daily lines, and the wallet bar
// are their entry points now.
const QUICK_ACCESS: { label: string; href: string; icon: LucideIcon }[] = [
  { label: 'History', href: '/transactions', icon: Receipt },
  { label: 'Orders', href: '/orders', icon: Package },
  { label: 'Vouchers', href: '/vouchers', icon: Ticket },
  { label: 'Inbox', href: '/notifications', icon: Bell },
  { label: 'Download', href: '/download', icon: Download },
  { label: 'Address', href: '/addresses', icon: MapPin },
  { label: 'Support', href: '/contact', icon: LifeBuoy },
  { label: 'Settings', href: '/settings', icon: Settings },
];

const ABOUT_LINKS: { label: string; href: string }[] = [
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Fairness', href: '/fairness' },
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
  { label: 'Activity', href: '/activity' },
];

export default async function MePage() {
  // Layout guard guarantees a customer here.
  const customer = (await getCustomer())!;
  const [walletResult, handle, vipResult, dailyResult, avatarFrames] =
    await Promise.all([
      getWallet(),
      getOwnProfileHandle(),
      getVip(),
      getDaily(),
      getAvatarFrames(),
    ]);
  // Second wave — needs the handle. Supplies header stats, points balance,
  // and the showcase strip in one cached public-route read.
  const profileResult = handle ? await getPublicProfile(handle) : null;
  const profile = profileResult?.status === 'ok' ? profileResult.profile : null;
  const showcased = profile?.collection ?? [];

  const displayName =
    [customer.first_name, customer.last_name].filter(Boolean).join(' ') ||
    handle ||
    customer.email;
  const meta = (customer.metadata ?? {}) as Record<string, unknown>;
  const avatarUrl =
    typeof meta.avatar_url === 'string' ? meta.avatar_url : null;
  const equippedLevel =
    typeof meta.equipped_frame_level === 'number'
      ? meta.equipped_frame_level
      : null;
  // null = "couldn't load", NOT "level 1" — a failed VIP read must never
  // render every frame as locked (2026-07-07 429-cascade incident).
  const highestLevel = vipResult.ok ? vipResult.vip.highestLevelEver : null;

  return (
    <EquippedFrameProvider initial={equippedLevel}>
      <div className="flex flex-col gap-4">
        <MeHeader
          displayName={displayName}
          handle={handle}
          pulls={profile ? profile.stats.pulls : null}
          points={profile ? profile.stats.points : null}
          avatarUrl={avatarUrl}
          frames={avatarFrames}
        />

        {/* Level card (Show's Lv bar): compact, VIP emblem on the right.
            The emblem is rendered on pure black and composited with
            mix-blend-screen so it melts into the card background. */}
        {vipResult.ok && (
          <div className="rounded-2xl border border-white/10 bg-neutral-900 px-4 py-3">
            <Link href="/vip" className="group flex items-center gap-3">
              <div className="min-w-0 flex-1 transition-opacity group-hover:opacity-90">
                <span className="font-heading text-chase text-xl">
                  LV {vipResult.vip.level}
                </span>
                {vipResult.vip.next ? (
                  <>
                    <div
                      className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-800"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={vipResult.vip.next.threshold}
                      aria-valuenow={
                        vipResult.vip.next.threshold -
                        vipResult.vip.next.remaining
                      }
                      aria-label={`Progress to VIP level ${vipResult.vip.next.level}`}
                    >
                      <div
                        className="bg-chase h-full rounded-full"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.max(
                              2,
                              ((vipResult.vip.next.threshold -
                                vipResult.vip.next.remaining) /
                                vipResult.vip.next.threshold) *
                                100,
                            ),
                          )}%`,
                        }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-[10px] font-semibold text-neutral-500">
                      <span>
                        {rm0(
                          vipResult.vip.next.threshold -
                            vipResult.vip.next.remaining,
                        )}
                      </span>
                      <span>{rm0(vipResult.vip.next.threshold)}</span>
                    </div>
                    <p className="text-[12px] text-neutral-400">
                      {rm0(vipResult.vip.next.remaining)} more to LV{' '}
                      {vipResult.vip.next.level}
                      {vipResult.vip.next.reward.voucherAmount > 0 &&
                        ` — unlocks a ${rm0(vipResult.vip.next.reward.voucherAmount)} voucher`}
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-[12px] text-neutral-400">
                    Max level reached — you&rsquo;re at the top of the ladder.
                  </p>
                )}
              </div>
              <span className="relative shrink-0">
                {/* Soft amber halo behind the badge. */}
                <span
                  aria-hidden
                  className="bg-chase/25 absolute left-1/2 top-1/2 h-12 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full blur-xl"
                />
                {/* Transparent-background asset — no blend mode needed (the
                    old wordmark was black-field + mix-blend-screen, which
                    broke inside any ancestor with opacity < 1). */}
                <Image
                  src="/images/app/vip-badge.webp"
                  alt=""
                  aria-hidden
                  width={761}
                  height={360}
                  className="relative h-9 w-auto"
                />
              </span>
            </Link>
            {dailyResult.ok && (
              <p className="mt-2 border-t border-white/5 pt-2 text-[12px] text-neutral-400">
                <Link href="/daily" className="hover:text-white">
                  Today&rsquo;s box:{' '}
                  <span className="font-semibold text-white">
                    {dailyResult.state.box &&
                    dailyResult.state.box.drawsToday >=
                      dailyResult.state.box.drawsPerDay
                      ? 'opened'
                      : dailyResult.state.box
                        ? 'ready'
                        : '—'}
                  </span>
                </Link>{' '}
                ·{' '}
                <Link href="/vip" className="hover:text-white">
                  {
                    dailyResult.state.vouchers.claimable.filter(
                      (g) => g.kind === 'voucher',
                    ).length
                  }{' '}
                  to claim
                </Link>{' '}
                ·{' '}
                <Link href="/vouchers" className="hover:text-white">
                  {
                    dailyResult.state.vouchers.claimed.filter(
                      (g) => g.kind === 'voucher',
                    ).length
                  }{' '}
                  claimed
                </Link>
              </p>
            )}
          </div>
        )}

        {/* 橱窗 — showcased cards. Hidden when the profile read fails. */}
        {profile && (
          <section className="rounded-2xl border border-white/10 bg-neutral-900 p-5">
            <div className="flex items-baseline justify-between">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
                Showcase
              </p>
              <Link
                href="/vault"
                className="text-[12px] font-semibold text-white/70 underline-offset-2 hover:text-white hover:underline"
              >
                Manage
              </Link>
            </div>
            {showcased.length > 0 ? (
              <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
                {showcased.map((card) => (
                  <Link
                    key={card.handle}
                    href={`/card/${card.handle}`}
                    className="w-20 shrink-0 transition-opacity hover:opacity-90"
                  >
                    <SlabImage
                      src={card.image}
                      slabSrc={card.slab_image}
                      alt={card.name}
                      sizes="80px"
                      className="w-20"
                    />
                  </Link>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[13px] text-neutral-400">
                Nothing showcased yet —{' '}
                <Link
                  href="/vault"
                  className="font-semibold text-white underline underline-offset-2"
                >
                  pick cards in your Vault
                </Link>
                .
              </p>
            )}
          </section>
        )}

        {/* Wallet bar */}
        <section className="rounded-2xl border border-white/10 bg-neutral-900 p-4">
          {walletResult.ok ? (
            <>
              {/* flex-wrap: a long balance pushes the buttons to their own
                  row instead of truncating money. */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Link href="/wallet" className="min-w-0 hover:opacity-90">
                  <p className="flex items-center gap-0.5 text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
                    Wallet
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                  </p>
                  <p className="font-heading mt-0.5 text-2xl text-white">
                    {rm(walletResult.wallet.balance)}
                  </p>
                </Link>
                <div className="flex shrink-0 gap-2">
                  <Link
                    href="/bank-withdrawal"
                    className={cn(
                      pillVariants({ variant: 'secondary', size: 'sm' }),
                    )}
                  >
                    Withdraw
                  </Link>
                  <TopUpButton size="sm" className="" />
                </div>
              </div>
              {walletResult.wallet.locked > 0 && (
                <p className="mt-2 text-[13px] text-neutral-400">
                  {rm(walletResult.wallet.available)} available ·{' '}
                  {rm(walletResult.wallet.locked)} locked
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-neutral-400">
              Couldn&rsquo;t load your balance.{' '}
              <Link
                href="/wallet"
                className="font-semibold text-white underline"
              >
                Open wallet
              </Link>
            </p>
          )}
        </section>

        {/* Invite friends + points balance */}
        <div className="grid grid-cols-2 gap-4">
          <Link
            href="/referrals"
            className="border-chase/30 bg-chase/10 hover:border-chase/60 rounded-2xl border p-4 transition-colors"
          >
            <Image
              src="/images/app/invite-gift.webp"
              alt=""
              aria-hidden
              width={239}
              height={240}
              className="h-12 w-12 mix-blend-screen"
            />
            <p className="mt-3 flex items-center gap-1 text-sm font-semibold text-white">
              Invite friends
              <ChevronRight
                className="h-3.5 w-3.5 text-neutral-500"
                aria-hidden
              />
            </p>
            <p className="mt-0.5 text-[12px] text-neutral-400">
              Easy cash rewards
            </p>
          </Link>
          <Link
            href={handle ? `/profile/${handle}` : '/vault'}
            className="rounded-2xl border border-white/10 bg-neutral-900 p-4 transition-colors hover:border-white/25"
          >
            <Image
              src="/images/app/points-coin.webp"
              alt=""
              aria-hidden
              width={212}
              height={240}
              className="h-12 w-auto mix-blend-screen"
            />
            <p className="mt-3 flex items-center gap-1 text-sm font-semibold text-white">
              Points balance
              <ChevronRight
                className="h-3.5 w-3.5 text-neutral-500"
                aria-hidden
              />
            </p>
            <p className="font-heading mt-0.5 text-xl text-white">
              {profile ? compact(profile.stats.points) : '—'}
            </p>
          </Link>
        </div>

        {/* Quick access grid */}
        <section className="rounded-2xl border border-white/10 bg-neutral-900 p-5">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
            Quick access
          </p>
          <div className="mt-4 grid grid-cols-4 gap-y-5">
            {QUICK_ACCESS.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex flex-col items-center gap-1.5 text-neutral-300 transition-colors hover:text-white"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-neutral-800">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="text-[11px] font-semibold">
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>

        {/* Frames (demoted below quick access — Show's Me has no frames row) */}
        <FramesCard highestLevel={highestLevel} frames={avatarFrames} />

        {/* About & help */}
        <section className="rounded-2xl border border-white/10 bg-neutral-900">
          {ABOUT_LINKS.map((link, i) => (
            <Link
              key={link.href}
              href={link.href}
              className={`flex h-12 items-center justify-between px-5 text-sm font-medium text-neutral-300 transition-colors hover:text-white ${
                i > 0 ? 'border-t border-white/5' : ''
              }`}
            >
              {link.label}
              <ChevronRight className="h-4 w-4 text-neutral-600" aria-hidden />
            </Link>
          ))}
        </section>

        <LogoutButton />
      </div>
    </EquippedFrameProvider>
  );
}
