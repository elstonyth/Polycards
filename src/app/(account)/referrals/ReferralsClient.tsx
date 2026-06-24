'use client';

import { useState } from 'react';
import { Panel } from '@/components/account/ui';

export default function ReferralsClient({ inviteUrl }: { inviteUrl: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Panel className="mt-5">
      <p className="mb-2 text-[12px] font-medium text-white/55">
        Your referral link
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          readOnly
          value={inviteUrl}
          className="h-11 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-white/80 focus:outline-none"
        />
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(`https://${inviteUrl}`);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-xl bg-neutral-200 px-5 py-2.5 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
        >
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>
    </Panel>
  );
}
