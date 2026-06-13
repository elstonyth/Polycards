'use client';

import { type ReactNode } from 'react';

/**
 * Opens the global auth modal (mounted once in SiteHeader). Fired as a window
 * CustomEvent so any component — header, marketing CTAs — can trigger it without
 * prop drilling or shared context. Matches the live site, which uses a modal for
 * login/signup rather than dedicated /login and /signup pages.
 */
export function openAuth(mode: 'login' | 'signup') {
  window.dispatchEvent(new CustomEvent('pokenic:auth', { detail: { mode } }));
}

export default function AuthButton({
  mode,
  className,
  children,
}: {
  mode: 'login' | 'signup';
  className?: string;
  children: ReactNode;
}) {
  return (
    <button type="button" className={className} onClick={() => openAuth(mode)}>
      {children}
    </button>
  );
}
