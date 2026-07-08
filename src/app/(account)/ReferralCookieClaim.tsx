'use client';

import { useEffect, useRef } from 'react';
import { applyReferral } from '@/lib/actions/referral';
import { REF_COOKIE } from '@/lib/referral-cookie';

/**
 * Belt-and-suspenders referral attribution. A guest who opened an /invite/<handle>
 * link had the sponsor stashed in the `pokenic_ref` cookie (see InviteClient). If
 * they signed up somewhere OTHER than the invite page (so its auto-apply never
 * ran), attribute them once here — on their first authenticated account landing —
 * then clear the cookie. This layout is auth-gated, so the visitor is a real
 * customer. The backend is idempotent (rejects a 2nd sponsor / self / cycle), so
 * a redundant call is harmless; we clear unconditionally and don't retry.
 */
export default function ReferralCookieClaim() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const handle = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${REF_COOKIE}=([^;]+)`),
    )?.[1];
    if (!handle) return;
    document.cookie = `${REF_COOKIE}=; path=/; max-age=0; samesite=lax`;
    void applyReferral(decodeURIComponent(handle));
  }, []);
  return null;
}
