import type { Metadata } from 'next';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import {
  Bell,
  ChevronRight,
  Download,
  Landmark,
  LifeBuoy,
  LogOut,
  MapPin,
  Package,
  Receipt,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { getCustomer } from '@/lib/data/customer';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';
import { getOwnProfileHandle, getPublicProfile } from '@/lib/data/profiles';
import { getWallet } from '@/lib/actions/wallet';
import { getPaymentLimits } from '@/lib/actions/vault';
import { getTicketBalance } from '@/lib/actions/lucky-draw';
import { DEFAULT_PAYMENT_LIMITS } from '@/lib/payment-limits';
import { sen, TOPUP_FIRST_HEADING } from '@/lib/wallet-split';
import { getVip } from '@/lib/actions/vip';
import { levelProgressPct } from '@/lib/actions/vip-map';
import { getAvatarFrames } from '@/lib/data/avatar-frames';
import { avatarForSeed } from '@/lib/avatar-seed';
import { num, rm, rm0 } from '@/lib/format';
import { SlabImage } from '@/components/SlabImage';
import { toCardView } from '@/lib/card-view';
import { WithdrawSteps } from '@/components/account/WithdrawSteps';
import { GlacierTopUpButton, LogoutButton } from './MeActions';
import { WithdrawLink } from '@/components/account/WithdrawLink';
import { MeHeader } from './MeAppearance';
import { EquippedFrameProvider } from './equipped-frame';
import { FAN_MAX, fanPose, joinedLabel } from './showcase-fan';
import { HoloIcon } from '@/components/holo-3d/HoloIcon';

export const metadata: Metadata = {
  title: 'Me',
  description: 'Your Polycards profile, wallet, rewards, and settings.',
};

// Quick-access grid (Show's Me pattern). VIP, Daily Box, and Withdraw tiles
// were dropped 2026-07-15; Vouchers went with the 2026-07-29 reward-surface
// suspension (routes 404 while the reward economy is paused). Bank arrived
// 2026-08-05 with real gateway payouts: saved accounts the withdraw form
// prefills, managed at /bank.
const QUICK_ACCESS: { label: string; href: string; icon: LucideIcon }[] = [
  { label: 'Referral', href: '/referral', icon: Users },
  { label: 'History', href: '/transactions', icon: Receipt },
  { label: 'Orders', href: '/orders', icon: Package },
  { label: 'Bank', href: '/bank', icon: Landmark },
  { label: 'Inbox', href: '/notifications', icon: Bell },
  { label: 'Download', href: '/download', icon: Download },
  { label: 'Address', href: '/addresses', icon: MapPin },
  { label: 'Support', href: '/contact', icon: LifeBuoy },
  { label: 'Settings', href: '/settings', icon: Settings },
];

// The "About & help" card (How it works / Fairness / About / Contact) was
// removed 2026-07-31 because the site footer carried the same links on this
// page. The footer lost its copy too, then got a link row back 2026-11-11
// (How it works / About / Contact / Privacy; /fairness was deleted that day),
// so don't re-add the card here: it would show those links twice in one
// scroll. `Support` in QUICK_ACCESS above still covers /contact.

const LABEL =
  'text-[11px] font-semibold tracking-[0.08em] text-neutral-400 uppercase';
const PANEL = 'rounded-3xl border border-white/10 bg-neutral-900 p-4 sm:p-5';
// A shortcut: a 48px round grey chip over its label, four to a row.
const TILE =
  'flex min-w-0 flex-col items-center gap-1.5 text-center text-[11px] font-semibold';
const TILE_ICON =
  'relative flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-neutral-800 transition-colors';

export default async function MePage() {
  // NOT guaranteed by the account layout's auth gate, despite how it reads:
  // App Router renders a layout and its page CONCURRENTLY, so the layout's
  // `redirect('/?auth=login')` does not run before this. A logged-out visitor
  // resolved null here and the old non-null assertion turned that into a 500
  // (`Cannot read properties of null (reading 'first_name')`, prod 05:15 UTC
  // 2026-08-17). Returning null lets the layout's redirect land — same guard
  // the sibling settings/page.tsx already carries.
  const customer = await getCustomer();
  if (!customer) return null;

  const [walletResult, handle, vipResult, avatarFrames, tickets, limits] =
    await Promise.all([
      getWallet(),
      getOwnProfileHandle(),
      getVip(),
      getAvatarFrames(),
      // null (unreadable) hides the Tickets number, as on the Vault.
      getTicketBalance(),
      // The deposit floor for the unlock steps (desktop) — the wallet page's
      // same read; any failure keeps the defaults.
      getPaymentLimits().catch((err: unknown) => {
        unstable_rethrow(err);
        return DEFAULT_PAYMENT_LIMITS;
      }),
    ]);
  // Locked gate (spend first): what packs must still take before withdrawals
  // open; null when withdrawals aren't waiting on packs.
  const gate = walletResult.ok ? walletResult.wallet : null;
  const unlockSpend = gate?.hold === 'locked' ? gate.unlockSpend : null;
  // The Withdraw button goes to the withdraw form only when there is
  // something to withdraw; otherwise to the wallet, which says why not.
  const canWithdraw =
    gate !== null && !gate.isFrozen && sen(gate.withdrawable) > 0;
  const cantYet = gate?.hold === 'no_topup' || gate?.hold === 'locked';
  // Second wave — needs the handle. Supplies the stats and the showcase in one
  // cached public-route read.
  const profileResult = handle ? await getPublicProfile(handle) : null;
  const profile = profileResult?.status === 'ok' ? profileResult.profile : null;
  const showcased = profile?.collection ?? [];
  const fanned = showcased.slice(0, FAN_MAX);

  const displayName =
    [customer.first_name, customer.last_name].filter(Boolean).join(' ') ||
    handle ||
    customer.email;
  // Presence, not verification: `phone_verified_at` lives on a backend state
  // row the storefront never reads. The cohort that field would add — a number
  // written before enforcement, still unverified — is covered where it
  // matters, by PhoneGateAction on the blocked action itself.
  const needsPhone = !customer.phone;
  const meta = (customer.metadata ?? {}) as Record<string, unknown>;
  // The same face the leaderboard and feed print: a stored avatar, else the one
  // the seed assigns. null only when the profile read failed (initial letter).
  const avatarUrl =
    typeof meta.avatar_url === 'string'
      ? meta.avatar_url
      : profile
        ? avatarForSeed(profile.seed)
        : null;
  const equippedLevel =
    typeof meta.equipped_frame_level === 'number'
      ? meta.equipped_frame_level
      : null;
  // null = "couldn't load", NOT "level 1" — a failed VIP read must never
  // render every frame as locked (2026-07-07 429-cascade incident).
  const highestLevel = vipResult.ok ? vipResult.vip.highestLevelEver : null;

  // The tier: the bar says how far to the next level. The fill restarts at
  // each level: it
  // measures spend inside [this level's threshold, the next one's], not
  // lifetime spend / next threshold (which pins it near-full at high levels).
  let tier: {
    level: number;
    text: string;
    bar: { now: number; min: number; max: number; next: number } | null;
  } | null = null;
  let progress = 0;
  if (vipResult.ok) {
    const { level, next, levels } = vipResult.vip;
    if (next) {
      const start = levels.find((l) => l.level === level)?.threshold ?? 0;
      const spent = next.threshold - next.remaining;
      progress = levelProgressPct(spent, start, next.threshold) / 100;
      tier = {
        level,
        text: `${rm0(next.remaining)} more to LV ${next.level}`,
        // Clamped to the segment floor: ARIA requires valuenow >= valuemin,
        // and a state-row level can in principle run ahead of settled spend.
        bar: {
          now: Math.max(start, spent),
          min: start,
          max: next.threshold,
          next: next.level,
        },
      };
    } else {
      progress = 1;
      tier = { level, text: 'Max level', bar: null };
    }
  }

  const balance = walletResult.ok ? walletResult.wallet : null;
  const numbers = profile
    ? [
        { label: 'Pulls', value: num(profile.stats.pulls) },
        {
          label: 'Legendary',
          value: num(profile.stats.by_rarity.Legendary ?? 0),
        },
        ...(tickets !== null
          ? [{ label: 'Tickets', value: num(tickets) }]
          : []),
        { label: 'Joined', value: joinedLabel(profile.joined_at) },
      ]
    : [];

  return (
    <EquippedFrameProvider initial={equippedLevel}>
      {/* `data-screen` lets the account layout drop its column: this page
          lays out its own width (one column on a phone, two on a phone on its
          side, three from lg as in the desktop mock-up). DOM order is the
          phone's order, so focus order follows what is seen; from lg the
          grid places each panel in its column. */}
      <div
        data-screen
        className="mx-auto grid w-full max-w-2xl gap-3 px-fluid pb-[calc(6rem+env(safe-area-inset-bottom))] pt-3 flat:max-w-none flat:grid-cols-2 lg:max-w-[1440px] lg:grid-cols-3 lg:gap-5 lg:pb-10 lg:pt-8"
      >
        {/* Tier card: the profile row, then the level and its bar. */}
        <section className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-neutral-900 p-4 squat:gap-2 squat:p-3 sm:p-5 lg:col-start-1 lg:row-start-1 lg:min-h-[260px] lg:justify-between">
          <MeHeader
            displayName={displayName}
            username={customer.first_name ?? ''}
            handle={handle}
            avatarUrl={avatarUrl}
            frames={avatarFrames}
            highestLevel={highestLevel}
            vipBadge={vipResult.ok}
          />
          {tier && (
            <div className="mt-auto lg:mt-0">
              <span className="inline-flex h-6 items-center rounded-md bg-chase px-2 font-heading text-[13px] leading-none text-neutral-950">
                LV {tier.level}
              </span>
              <p className="mt-2 text-[13px] font-medium text-neutral-50">
                {tier.text}
              </p>
              {tier.bar && (
                <div
                  role="progressbar"
                  aria-valuemin={tier.bar.min}
                  aria-valuemax={tier.bar.max}
                  aria-valuenow={tier.bar.now}
                  aria-label={`Progress to VIP level ${tier.bar.next}`}
                  className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/10"
                >
                  <div
                    className="h-full rounded-full bg-glacier-grad"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </section>

        {/* Balance card: the money action in a phone's first screen. */}
        <section
          aria-label="Balance"
          className={cn(
            PANEL,
            // squat: an SE-sized phone must still show Top Up above the tab bar.
            'relative overflow-hidden pb-5 squat:p-3 squat:pb-4 sm:pb-6 lg:col-start-2 lg:row-start-1 lg:p-6',
          )}
        >
          {balance ? (
            <>
              <Link
                href="/wallet"
                className="block min-w-0 rounded-lg hover:opacity-90"
              >
                <span className={cn(LABEL, 'flex items-center gap-0.5')}>
                  Balance
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                </span>
                <span className="mt-1.5 block whitespace-nowrap font-heading text-[2.25rem] leading-none text-white tabular-nums lg:text-[2.75rem]">
                  {rm(balance.balance)}
                </span>
              </Link>
              {!balance.isFrozen && (
                <p className="mt-2 text-[13px] text-neutral-400">
                  Withdrawable{' '}
                  <span className="whitespace-nowrap">
                    {rm(balance.withdrawable)}
                  </span>
                </p>
              )}
              {/* Right above the Withdraw button it would otherwise find out
                  from. Bonus alone never withdraws, so no hint. */}
              {!balance.hasTopup &&
                !balance.isFrozen &&
                sen(balance.balance) > sen(balance.bonus) && (
                  <p className="mt-1 text-[12px] font-semibold text-glacier">
                    {TOPUP_FIRST_HEADING}
                  </p>
                )}
              {unlockSpend !== null && (
                <p className="mt-1 text-[12px] font-semibold text-glacier">
                  Use{' '}
                  <span className="whitespace-nowrap">{rm(unlockSpend)}</span>{' '}
                  more on packs to unlock withdrawals.
                </p>
              )}
              <div className="mt-4 flex gap-2 squat:mt-3 lg:mt-6">
                <GlacierTopUpButton className="flex-1 px-4" />
                {canWithdraw ? (
                  <WithdrawLink
                    className={cn(
                      pillVariants({ variant: 'secondary' }),
                      'flex-1 px-4',
                    )}
                  >
                    Withdraw
                  </WithdrawLink>
                ) : unlockSpend !== null ? (
                  <Link
                    href="/slots"
                    className={cn(
                      pillVariants({ variant: 'secondary' }),
                      'flex-1 px-4',
                    )}
                  >
                    Open packs
                  </Link>
                ) : (
                  <Link
                    href="/wallet"
                    className={cn(
                      pillVariants({ variant: 'secondary' }),
                      'flex-1 px-4',
                    )}
                  >
                    Withdraw
                  </Link>
                )}
              </div>
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

        {numbers.length > 0 && (
          <dl
            className={cn(
              PANEL,
              'grid auto-cols-fr grid-flow-col divide-x divide-white/10 px-0 py-3.5 sm:px-0 lg:col-start-1 lg:row-start-2',
            )}
          >
            {numbers.map((n) => (
              <div
                key={n.label}
                // justify-center: on desktop the row is as tall as its
                // neighbour, and the numbers sat on the panel's floor.
                className="flex min-w-0 flex-col-reverse items-center justify-center gap-1 px-1 text-center"
              >
                <dt className="truncate text-[12px] text-neutral-400">
                  {n.label}
                </dt>
                <dd className="font-heading text-lg leading-none text-white tabular-nums lg:text-xl">
                  {n.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {/* Quick access, Log out its last tile. Frames live in the Edit
            Profile modal (tap the avatar, the name or Edit). */}
        <nav
          aria-label="Quick access"
          className="grid grid-cols-4 gap-x-2 gap-y-4 py-1 flat:row-span-2 flat:self-start lg:col-start-3 lg:row-start-1 lg:rounded-3xl lg:border lg:border-white/10 lg:bg-neutral-900 lg:p-5"
        >
          {QUICK_ACCESS.map((item) => {
            const Icon = item.icon;
            // A phoneless account is refused by every money/goods path
            // (backend requirePhoneVerified: top-up, deposit, withdraw,
            // delivery), and nothing on this screen says so until they hit
            // the wall. Light the tile that fixes it.
            const highlight = needsPhone && item.href === '/settings';
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  TILE,
                  'group',
                  highlight
                    ? 'text-white'
                    : 'text-neutral-300 hover:text-white',
                )}
              >
                {/* Paper White, not Chase Gold: gold is reserved for prize
                    and value moments, and a collector trained on gold =
                    prize reads a gold Settings tile as "reward waiting". */}
                <span
                  className={cn(
                    TILE_ICON,
                    highlight
                      ? 'bg-white/15 ring-1 ring-white/40'
                      : 'group-hover:bg-neutral-700',
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                  {highlight && (
                    <span
                      aria-hidden
                      className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-neutral-50"
                    />
                  )}
                </span>
                {item.label}
                {/* Colour alone is invisible to a screen reader, and it is
                    the only thing separating this tile from the others. */}
                {highlight && (
                  <span className="sr-only">— add your phone number</span>
                )}
              </Link>
            );
          })}
          <LogoutButton
            className={cn(
              TILE,
              'h-auto w-auto justify-start rounded-none border-0 text-[11px] text-neutral-300',
            )}
            icon={
              <span className={TILE_ICON}>
                <LogOut className="h-5 w-5" aria-hidden />
              </span>
            }
          />
        </nav>

        {/* 橱窗 — showcased cards, fanned. Hidden when the profile read
            fails. */}
        {profile && (
          <section
            className={cn(PANEL, 'pb-3 sm:pb-4 lg:col-start-1 lg:row-start-3')}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-heading text-lg text-white">Showcase</h2>
              <Link
                href="/vault"
                className="inline-flex min-h-11 items-center gap-0.5 text-[13px] font-semibold text-glacier underline-offset-2 hover:underline"
              >
                Manage
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            {fanned.length > 0 ? (
              <div className="relative flex h-[150px] items-center justify-center">
                {fanned.map((card, i) => {
                  const pose = fanPose(i, fanned.length);
                  return (
                    <Link
                      // Two showcased pulls of the SAME card are two
                      // distinct items (and can carry different tier
                      // frames — rarity is per (pack, card)). The payload
                      // has no pull id, so the index disambiguates; the
                      // public profile keys the same way.
                      key={`${card.handle}-${i}`}
                      href={`/card/${card.handle}`}
                      className="relative w-[58px] shrink-0 transition-transform duration-200 [transform:translateY(var(--y))_rotate(var(--r))_scale(var(--s))] [&:not(:first-of-type)]:-ml-2 hover:[transform:translateY(calc(var(--y)-6px))_rotate(var(--r))_scale(var(--s))]"
                      style={
                        {
                          // the board's curve, at this panel's smaller slab
                          '--y': `${pose.y * 0.7}px`,
                          '--r': `${pose.rotate}deg`,
                          '--s': pose.scale,
                          zIndex: pose.z,
                        } as React.CSSProperties
                      }
                    >
                      <SlabImage
                        // The showcase is the one surface that renders the
                        // profile WIRE row rather than the mapped view —
                        // the shared mapper turns it into a card view here.
                        card={toCardView(card)}
                        // Thumbnail-sized slab: the full-size halo is wider
                        // than the slab and would bleed into neighbours.
                        glowScale={0.4}
                        sizes="58px"
                        className="w-[58px] drop-shadow-[0_12px_12px_rgba(0,0,0,.7)]"
                      />
                    </Link>
                  );
                })}
                {showcased.length > FAN_MAX && (
                  <Link
                    href="/vault"
                    className="absolute -bottom-2 right-0 inline-flex min-h-11 items-center text-[12px] font-semibold text-neutral-400 hover:text-white"
                  >
                    +{showcased.length - FAN_MAX} more
                  </Link>
                )}
              </div>
            ) : (
              <p className="pb-2 text-[13px] text-neutral-400">
                Nothing showcased yet —{' '}
                <Link
                  href="/vault"
                  className="font-semibold text-glacier underline underline-offset-2"
                >
                  pick cards in your Vault
                </Link>
                .
              </p>
            )}
          </section>
        )}

        {/* Desktop only: the wallet's unlock steps (a phone has the one-line
            note in the balance card), then the invite card. */}
        {gate && cantYet && (
          <section
            className={cn(
              PANEL,
              'hidden lg:col-start-2 lg:row-span-2 lg:row-start-2 lg:block lg:self-start lg:p-6',
            )}
          >
            <h2 className="font-heading text-lg text-white">
              Unlock withdrawals
            </h2>
            <WithdrawSteps
              className="mt-4"
              topUpButton={false}
              hasTopup={gate.hasTopup}
              depositMinRm={limits.deposit.minRm}
              available={gate.available}
              bonus={gate.bonus}
              remaining={gate.playthrough.remaining}
            />
          </section>
        )}

        <section
          className={cn(
            PANEL,
            // The gift sits inside the card so its top lines up with the row.
            'relative hidden lg:col-start-3 lg:row-span-2 lg:row-start-2 lg:block lg:self-start lg:p-6',
          )}
        >
          <HoloIcon
            kind="gift"
            cage
            className="absolute top-1/2 right-1 w-44 -translate-y-1/2"
          />
          <h2 className="max-w-[55%] font-heading text-xl text-white">
            Invite friends
          </h2>
          <p className="mt-2 max-w-[55%] text-[13px] text-neutral-400">
            Every pack your friends rip pays you a weekly cut.
          </p>
          <Link
            href="/referral"
            className={cn(pillVariants({ variant: 'primary' }), 'mt-5')}
          >
            Get your link
          </Link>
        </section>
      </div>
    </EquippedFrameProvider>
  );
}
