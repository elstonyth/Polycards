'use client';

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
import type { ReferralSummary } from '@/lib/data/schemas';

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
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-live="polite"
      aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
      className="flex h-11 w-full min-w-0 items-center gap-2 rounded-xl bg-neutral-900 px-3 text-left outline-none transition-colors hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <span className="w-8 shrink-0 text-[11px] text-neutral-500">{label}</span>
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

function ReferralBody({ data }: { data: ReferralSummary }) {
  const origin = useOrigin();
  const [copied, setCopied] = useState<Copied>(null);

  const path = `/r/${data.code}`;
  const url = `${origin}${path}`;
  // Shown without the scheme ("polycards.gg/r/F42B0700"); the path alone until
  // the origin is known.
  const display = origin ? url.replace(/^https?:\/\//, '') : path;

  const copy = async (what: Exclude<Copied, null>) => {
    try {
      await navigator.clipboard.writeText(what === 'link' ? url : data.code);
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
          text: `Use my referral code ${data.code} when you sign up — we both earn as you rip.`,
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
    <div className="space-y-4">
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
              value={data.code}
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
