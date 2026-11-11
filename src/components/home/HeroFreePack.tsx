'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import { useFreePackState } from '@/components/FreePackBadge';
import type { FreePackState } from '@/lib/data/free-pack';

const ROW =
  'group mt-5 flex w-full max-w-sm items-center gap-3 rounded-xl border border-white/10 bg-neutral-900 p-2 pr-4 text-left transition-[background-color,border-color,transform] duration-150 hover:border-white/20 hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100';

/**
 * The free welcome pack's home entry point, inline under the hero's actions
 * (the floating badge skips "/"). The home page is route-cached and reads no
 * cookies, so the server passes only the visitor-agnostic answer — is a pack
 * on offer to a new visitor (`promo`) — and that paints the guest row in the
 * first paint, with no layout shift for visitors. Once auth settles, the
 * per-customer answer takes over: a member with an unclaimed pack gets the
 * claim row, everyone else nothing.
 */
export function HeroFreePack({ promo }: { promo: boolean }) {
  const { customer, isLoading } = useAuth();
  const answer = useFreePackState(true);
  const state: FreePackState =
    answer ??
    // Before the per-customer answer lands: a guest (or a visitor whose auth
    // is still hydrating, i.e. the server render) sees the server's offer; a
    // member sees nothing rather than a sign-up pitch.
    ((isLoading || !customer) && promo
      ? { mode: 'signup' }
      : { mode: 'hidden' });

  if (state.mode === 'hidden') return null;

  const body = (title: string, line: string) => (
    <>
      <span className="flex h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]">
        <Image
          src="/branding/polycards-mark.png"
          alt=""
          width={57}
          height={81}
          className="h-6 w-auto"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="mt-0.5 block text-xs text-neutral-400">{line}</span>
      </span>
      <ArrowRight
        className="size-4 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-0.5 group-hover:text-white motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
        aria-hidden
      />
    </>
  );

  if (state.mode === 'signup') {
    return (
      <button
        type="button"
        onClick={() => openAuth('signup')}
        data-testid="hero-free-pack"
        className={ROW}
      >
        {body('Your first pack is free', 'Sign up to open it.')}
      </button>
    );
  }
  return (
    <Link
      href={`/slots/${encodeURIComponent(state.slug)}/spin`}
      data-testid="hero-free-pack"
      className={ROW}
    >
      {body(
        'Your free pack is ready',
        state.missing?.length
          ? 'Verify your account, then open it.'
          : 'Open it now. No top-up needed.',
      )}
    </Link>
  );
}
