'use client';

import { useState } from 'react';
import { Check, Copy, Share2 } from 'lucide-react';
import { Pill } from '@/components/ui/pill';

/** Invite-link card: copy + native share sheet (showgo's "Share Invite Link"). */
export default function ReferralsClient({ inviteUrl }: { inviteUrl: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied (insecure context / permission) — no-op */
    }
  }

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Polycards',
          text: 'Rip packs, pull real graded cards — join me on Polycards:',
          url: inviteUrl,
        });
      } else {
        await copy();
      }
    } catch {
      /* user dismissed the share sheet — no-op */
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-white/10 bg-neutral-900 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        Your invite link
      </p>
      <div className="mt-2 flex items-center gap-2 rounded-xl bg-neutral-800 px-3.5 py-3">
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
          {inviteUrl}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy invite link'}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-neutral-200 transition-colors hover:text-white"
        >
          {copied ? (
            <Check className="h-4 w-4 text-buyback-fg" aria-hidden />
          ) : (
            <Copy className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
      <Pill onClick={share} size="lg" className="mt-3 w-full">
        <Share2 className="h-4 w-4" aria-hidden />
        Share invite link
      </Pill>
    </div>
  );
}
