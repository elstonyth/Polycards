'use client';

import { useState } from 'react';
import { Check, Copy, Share2 } from 'lucide-react';

/** Invite-link card: copy + native share sheet (showgo's "Share Invite Link"). */
export default function ReferralsClient({ inviteUrl }: { inviteUrl: string }) {
  const [copied, setCopied] = useState(false);

  const absoluteUrl = /^https?:\/\//i.test(inviteUrl)
    ? inviteUrl
    : `https://${inviteUrl}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(absoluteUrl);
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
          title: 'Pokenic',
          text: 'Rip packs, pull real graded cards — join me on Pokenic:',
          url: absoluteUrl,
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
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-neutral-200 transition-colors hover:text-white"
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-400" aria-hidden />
          ) : (
            <Copy className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
      <button
        type="button"
        onClick={share}
        className="mt-3 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-neutral-50 text-sm font-semibold text-neutral-950 transition-transform active:scale-[0.98]"
      >
        <Share2 className="h-4 w-4" aria-hidden />
        Share invite link
      </button>
    </div>
  );
}
