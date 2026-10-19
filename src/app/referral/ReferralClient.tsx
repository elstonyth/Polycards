'use client';

import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { Check, Copy, Share2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Pill } from '@/components/ui/pill';
import { HelpTip } from '@/components/ui/help-tip';
import {
  fromCents,
  HistoryList,
  Panel,
  pct,
  SignInPrompt,
  Stat,
  TabBanner,
  UnavailablePanel,
} from '@/components/task-ui';
import { mytDate } from '@/lib/format';
import type { ReferralFriend, ReferralSummary } from '@/lib/data/schemas';

// The absolute link needs the page's real origin, which only exists in the
// browser. useSyncExternalStore hands SSR/hydration the empty server snapshot
// and the client its origin right after — no markup mismatch, and no baked-in
// NEXT_PUBLIC_SITE_URL that could print the wrong host into every QR.
const noSubscribe = () => () => {};
const useOrigin = () =>
  useSyncExternalStore(
    noSubscribe,
    () => window.location.origin,
    () => '',
  );

type Copied = 'link' | 'code' | null;

function CopyRow({
  label,
  value,
  copied,
  onCopy,
  small,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  /** The link is the long one — a step smaller so "host/r/CODE" fits beside
   *  the QR on a 375px phone without truncating. */
  small?: boolean;
}) {
  // A row-shaped copy control, not a Pill (DESIGN.md §5 shapes buttons as
  // pills) — but it carries the same states: press scale, focus ring,
  // reduced-motion opt-out.
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-live="polite"
      aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
      className="flex h-11 w-full min-w-0 items-center gap-2 rounded-xl bg-neutral-900 px-3 text-left outline-none transition-[background-color,transform] select-none hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-white/40 active:scale-[0.98] motion-reduce:transition-[background-color] motion-reduce:active:scale-100"
    >
      <span className="w-8 shrink-0 text-[11px] text-neutral-400">{label}</span>
      <span
        className={`min-w-0 flex-1 truncate font-mono font-semibold text-white ${small ? 'text-xs' : 'text-sm'}`}
      >
        {value}
      </span>
      {copied ? (
        <Check className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
      ) : (
        <Copy className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
      )}
    </button>
  );
}

function SharePanel({ code }: { code: string }) {
  const origin = useOrigin();
  const [copied, setCopied] = useState<Copied>(null);

  const path = `/r/${code}`;
  const url = `${origin}${path}`;
  // Shown without the scheme ("polycards.gg/r/F42B0700"); the path alone until
  // the origin is known.
  const display = origin ? url.replace(/^https?:\/\//, '') : path;

  const copy = async (what: Exclude<Copied, null>) => {
    try {
      await navigator.clipboard.writeText(what === 'link' ? url : code);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard unavailable (permissions/http) — both values are visible to
      // select manually, so silently doing nothing beats an error toast.
    }
  };

  const share = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'Join me on Polycards',
          text: `Use my referral code ${code} when you sign up — we both earn as you rip.`,
          url,
        });
      } catch {
        // The visitor dismissed the share sheet — nothing to do.
      }
      return;
    }
    await copy('link');
  };

  return (
    <Panel>
      <p className="text-[11px] tracking-wide text-white/40 uppercase">
        Share your code
      </p>
      {/* Rows sit beside the QR from 400px up; below that the link would
          truncate, so they stack under a centred QR instead. */}
      <div className="mt-3 flex flex-col gap-3 min-[400px]:flex-row">
        <div
          role="img"
          aria-label={`QR code for ${url}`}
          className="mx-auto flex h-24 w-24 shrink-0 items-center justify-center rounded-xl bg-white p-2 min-[400px]:mx-0"
        >
          {origin ? (
            <QRCodeSVG value={url} size={80} level="M" marginSize={0} />
          ) : (
            <span className="h-20 w-20 rounded bg-neutral-200" aria-hidden />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
          <CopyRow
            label="Link"
            value={display}
            copied={copied === 'link'}
            onCopy={() => copy('link')}
            small
          />
          <CopyRow
            label="Code"
            value={code}
            copied={copied === 'code'}
            onCopy={() => copy('code')}
          />
        </div>
      </div>
      <Pill className="mt-3 w-full" onClick={share}>
        <Share2 className="h-4 w-4" aria-hidden />
        Share
      </Pill>
      <p className="mt-3 text-xs leading-relaxed text-neutral-500">
        Friends who sign up with your link or code count toward your weekly
        commission — a cut of everything they rip, paid every Wednesday.
      </p>
    </Panel>
  );
}

// Who the player invited, newest first. Names follow the leaderboard (public
// display name, linked to the profile when it has a handle) — the backend
// never sends a friend's email, phone or id. Last on the page so a long list
// doesn't push the payouts out of sight.
function FriendsPanel({
  friends,
  total,
}: {
  friends: ReferralFriend[];
  total: number;
}) {
  return (
    <Panel>
      <p className="mb-1 text-[11px] tracking-wide text-white/40 uppercase">
        Your friends
      </p>
      {friends.length === 0 ? (
        <p className="py-3 text-center text-sm text-neutral-400">
          No friends yet — share your code and they&rsquo;ll show up here.
        </p>
      ) : (
        <ul className="divide-y divide-white/5">
          {friends.map((f, i) => (
            <li
              key={`${f.joined_at}-${i}`}
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="min-w-0 flex-1">
                {f.handle ? (
                  <Link
                    href={`/profile/${f.handle}`}
                    className="-my-1 block min-h-11 truncate py-3 text-sm font-semibold text-white hover:underline"
                  >
                    {f.name}
                  </Link>
                ) : (
                  <span className="block truncate py-2 text-sm font-semibold text-white">
                    {f.name}
                  </span>
                )}
                <p className="text-xs text-neutral-400">
                  Joined {mytDate(f.joined_at)}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p
                  className={
                    f.week_spend_cents > 0
                      ? 'text-sm text-white'
                      : 'text-sm text-neutral-400'
                  }
                >
                  {fromCents(f.week_spend_cents)}
                </p>
                <p className="text-xs text-neutral-400">spent this week</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {friends.length < total && (
        <p className="mt-2 text-xs text-neutral-400">
          Showing your newest {friends.length} of {total} friends.
        </p>
      )}
    </Panel>
  );
}

function ReferralBody({ data }: { data: ReferralSummary }) {
  return (
    <div className="space-y-4">
      {data.code ? (
        <SharePanel code={data.code} />
      ) : (
        // Deploy skew: a backend that predates referral codes still serves the
        // stats below — only the share panel waits.
        <Panel>
          <p className="text-sm leading-relaxed text-neutral-400">
            Your referral code is on its way — check back in a moment.
          </p>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Referrals"
          value={String(data.downline_count)}
          help={
            <HelpTip label="What counts as a referral">
              Accounts created with your link or code. It only binds at signup,
              so an existing account can&rsquo;t be added later.
            </HelpTip>
          }
        />
        <Stat
          label="Their spend this week"
          value={fromCents(data.week.turnover_cents)}
        />
        <Stat
          label={data.week.partner ? 'Partner rate' : 'Current rate'}
          value={pct(data.week.rate_bp)}
          help={
            <HelpTip label="How your current rate is set">
              {data.week.partner ? (
                <>
                  You&rsquo;re on a partner rate — a fixed percentage set by our
                  team that replaces the standard tiers.
                </>
              ) : (
                <>
                  Your rate comes from what your referrals spend in a week —
                  more spend, higher rate. It applies to the whole week&rsquo;s
                  total, not just the amount above each step:
                  <br />
                  <br />
                  RM0–5,999 → 0.5%
                  <br />
                  RM6,000–14,999 → 1%
                  <br />
                  RM15,000–29,999 → 1.5%
                  <br />
                  RM30,000+ → 2%
                </>
              )}
            </HelpTip>
          }
        />
        <Stat
          label="Next payout"
          value={fromCents(data.week.projected_cents)}
          help={
            <HelpTip label="When the next payout lands">
              An estimate for the week in progress. The week closes Tuesday
              00:00 (Malaysia time) and the credit lands on Wednesday, so this
              number can still move.
            </HelpTip>
          }
        />
      </div>

      <Panel>
        <p className="mb-1 text-[11px] tracking-wide text-white/40 uppercase">
          Past payouts
        </p>
        <HistoryList
          rows={data.history}
          empty="No payouts yet — share your code to start earning."
        />
      </Panel>

      {/* Absent on a backend that predates the list: hide it rather than
          tell a player with referrals they have none. */}
      {data.friends && (
        <FriendsPanel friends={data.friends} total={data.downline_count} />
      )}
    </div>
  );
}

export function ReferralClient({
  data,
  isLoggedIn,
}: {
  data: ReferralSummary | null;
  isLoggedIn: boolean;
}) {
  return (
    <div className="px-fluid mx-auto w-full max-w-2xl py-6">
      <h1 className="font-heading text-3xl text-white">REFERRAL</h1>
      <div className="mt-4">
        <TabBanner
          src="/images/task/referral-banner.webp"
          title="INVITE & EARN"
          sub="Every pack your friends rip pays you a weekly cut."
        />
        {data ? (
          <ReferralBody data={data} />
        ) : isLoggedIn ? (
          <UnavailablePanel />
        ) : (
          <SignInPrompt what="your referral code and earnings" />
        )}
      </div>
    </div>
  );
}
