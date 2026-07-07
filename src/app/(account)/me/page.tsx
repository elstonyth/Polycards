import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Bell,
  ChevronRight,
  Crown,
  Gift,
  Landmark,
  Package,
  Receipt,
  Settings,
  Sparkles,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import { getCustomer } from '@/lib/data/customer';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';
import { getOwnProfileHandle } from '@/lib/data/profiles';
import { getWallet } from '@/lib/actions/wallet';
import { getVip } from '@/lib/actions/vip';
import { getDaily } from '@/lib/actions/daily';
import { getAvatarFrames } from '@/lib/data/avatar-frames';
import { rm, rm0 } from '@/lib/format';
import { LogoutButton, TopUpButton } from './MeActions';
import { AppearanceCard } from './AppearanceCard';

export const metadata: Metadata = {
  title: 'Me',
  description: 'Your Pokenic profile, wallet, rewards, and settings.',
};

// Quick-access grid (showgo's Me pattern): everything that used to live in the
// account sidebar, minus Vault/Wallet which have their own surfaces now.
const QUICK_ACCESS: { label: string; href: string; icon: LucideIcon }[] = [
  { label: 'VIP', href: '/vip', icon: Crown },
  { label: 'Daily Box', href: '/daily', icon: Sparkles },
  { label: 'Orders', href: '/orders', icon: Package },
  { label: 'History', href: '/transactions', icon: Receipt },
  { label: 'Vouchers', href: '/vouchers', icon: Ticket },
  { label: 'Settings', href: '/settings', icon: Settings },
  { label: 'Withdraw', href: '/bank-withdrawal', icon: Landmark },
  { label: 'Inbox', href: '/notifications', icon: Bell },
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
    <div className="flex flex-col gap-4">
      <AppearanceCard
        displayName={displayName}
        subtitle={`${handle ? `@${handle} · ` : ''}${customer.email}`}
        avatarUrl={avatarUrl}
        equippedLevel={equippedLevel}
        highestLevel={highestLevel}
        frames={avatarFrames}
      />

      {/* Wallet card */}
      <section className="rounded-2xl border border-white/10 bg-neutral-900 p-5">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
          Wallet
        </p>
        {walletResult.ok ? (
          <>
            <p className="font-heading mt-1 text-3xl text-white">
              {rm(walletResult.wallet.balance)}
            </p>
            {walletResult.wallet.locked > 0 && (
              <p className="mt-1 text-[13px] text-neutral-400">
                {rm(walletResult.wallet.available)} available ·{' '}
                {rm(walletResult.wallet.locked)} locked
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <TopUpButton />
              <Link
                href="/bank-withdrawal"
                className={cn(pillVariants({ variant: 'secondary' }), 'flex-1')}
              >
                Withdraw
              </Link>
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-neutral-400">
            Couldn’t load your balance.{' '}
            <Link href="/wallet" className="font-semibold text-white underline">
              Open wallet
            </Link>
          </p>
        )}
      </section>

      {/* VIP progress */}
      {vipResult.ok && (
        <div className="rounded-2xl border border-white/10 bg-neutral-900 p-5">
          <Link href="/vip" className="block hover:opacity-90">
            <div className="flex items-baseline justify-between">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
                VIP
              </p>
              <span className="font-heading text-chase text-xl">
                LV {vipResult.vip.level}
              </span>
            </div>
            {vipResult.vip.next ? (
              <>
                <div
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-800"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={vipResult.vip.next.threshold}
                  aria-valuenow={
                    vipResult.vip.next.threshold - vipResult.vip.next.remaining
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
                <p className="mt-2 text-[13px] text-neutral-400">
                  {rm0(vipResult.vip.next.remaining)} more to LV{' '}
                  {vipResult.vip.next.level}
                  {vipResult.vip.next.reward.voucherAmount > 0 &&
                    ` — unlocks a ${rm0(vipResult.vip.next.reward.voucherAmount)} voucher`}
                </p>
              </>
            ) : (
              <p className="mt-2 text-[13px] text-neutral-400">
                Max level reached — you&rsquo;re at the top of the ladder.
              </p>
            )}
          </Link>
          {dailyResult.ok && (
            <div className="mt-3 space-y-1 border-t border-white/5 pt-3">
              <p className="text-[13px] text-neutral-400">
                <Link href="/daily" className="hover:text-white">
                  Today&rsquo;s box:{' '}
                  <span className="font-semibold text-white">
                    {dailyResult.state.box &&
                    dailyResult.state.box.drawsToday >=
                      dailyResult.state.box.drawsPerDay
                      ? 'opened — resets tomorrow'
                      : dailyResult.state.box
                        ? 'ready to open'
                        : '—'}
                  </span>
                </Link>
              </p>
              <p className="text-[13px] text-neutral-400">
                <Link href="/vip" className="hover:text-white">
                  {
                    dailyResult.state.vouchers.claimable.filter(
                      (g) => g.kind === 'voucher',
                    ).length
                  }{' '}
                  voucher(s) to claim
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
            </div>
          )}
        </div>
      )}

      {/* Invite friends */}
      <Link
        href="/referrals"
        className="border-chase/30 bg-chase/10 flex items-center justify-between rounded-2xl border p-4 transition-colors hover:border-chase/60"
      >
        <div className="flex items-center gap-3">
          <span className="bg-chase/20 flex h-10 w-10 items-center justify-center rounded-full">
            <Gift className="text-chase h-5 w-5" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold text-white">Invite friends</p>
            <p className="text-[12px] text-neutral-400">
              Earn credit on every pack they rip
            </p>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-neutral-500" aria-hidden />
      </Link>

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
                <span className="text-[11px] font-semibold">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </section>

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
  );
}
