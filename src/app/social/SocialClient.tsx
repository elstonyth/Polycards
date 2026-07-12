'use client';

import Link from 'next/link';
import { Users } from 'lucide-react';
import Reveal from '@/components/Reveal';
import { compact } from '@/lib/format';
import { MOCK_USERS } from '@/lib/mock/users';

export default function SocialClient() {
  return (
    <div className="mx-auto w-full px-fluid py-6">
      <Reveal as="header" className="mb-5">
        <div className="flex items-center gap-2.5">
          <Users className="h-5 w-5 text-sky-400" aria-hidden />
          <h1 className="font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Community
          </h1>
        </div>
        <p className="mt-2 text-sm text-white/55">
          Connect with collectors and traders.
        </p>
      </Reveal>

      {/* User grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MOCK_USERS.map((u, i) => (
          <Reveal
            key={u.username}
            delay={Math.min(i, 8) * 45}
            className="h-full"
          >
            <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20">
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={u.pfp}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-full object-cover ring-1 ring-white/10"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">
                    {u.username}
                  </p>
                  <p className="text-[12px] text-white/50">
                    {compact(u.points)} pts · #{u.rank}
                  </p>
                </div>
              </div>
              <div className="mt-4">
                <Link
                  href={`/profile/${u.username}`}
                  className="flex h-9 items-center justify-center rounded-lg bg-neutral-200 text-[12px] font-semibold text-neutral-950 transition-colors hover:bg-white"
                >
                  Profile
                </Link>
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      <p className="mt-6 text-center text-[11px] text-white/55">
        Demo — community features launch with trading.
      </p>
    </div>
  );
}
