'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
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

function ReferralBody({ data }: { data: ReferralSummary }) {
  const [copied, setCopied] = useState(false);

  // Rendered as a path (identical on server and client — no hydration skew);
  // the copy handler runs client-only, so it can prepend the real origin.
  const invitePath = `/invite/${data.handle}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${invitePath}`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions/http) — the URL is visible to
      // select manually, so silently doing nothing beats an error toast.
    }
  };

  return (
    <div className="space-y-4">
      <Panel>
        <p className="text-[11px] tracking-wide text-white/40 uppercase">
          Your invite link
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
            {invitePath}
          </code>
          <Pill size="sm" variant="secondary" onClick={copy} aria-live="polite">
            {copied ? (
              <Check className="h-4 w-4" aria-hidden />
            ) : (
              <Copy className="h-4 w-4" aria-hidden />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Pill>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-neutral-500">
          Friends who sign up through your link count toward your weekly
          commission — a cut of everything they rip, paid every Wednesday.
        </p>
      </Panel>

      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Referrals"
          value={String(data.downline_count)}
          help={
            <HelpTip label="What counts as a referral">
              Accounts created through your invite link. The link only binds at
              signup, so an existing account can&rsquo;t be added later.
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
          empty="No payouts yet — share your link to start earning."
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
          <SignInPrompt what="your referral link and earnings" />
        )}
      </div>
    </div>
  );
}
