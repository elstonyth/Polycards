'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth/AuthProvider';
import { reloadForVersionSkew } from '@/lib/version-skew';

type Modal = typeof import('@/components/AuthModal').default;

const loadModal = () => import('@/components/AuthModal');

/** A guest who has stayed this long gets the form warmed, so Join opens at once. */
const WARM_AFTER_MS = 6_000;

/**
 * Keeps the signup form and its phone library (~120 KB of parsed JS) off every
 * page: AuthModal mounts on the first openAuth() or ?auth= arrival, and the
 * latest event while it loads is handed over because it has already fired.
 *
 * Not next/dynamic: this sits in the root layout, above every error.tsx, so a
 * failed chunk would replace the whole page. A tab left open across a deploy
 * reloads instead, and otherwise the next tap tries again.
 */
export default function AuthModalLoader() {
  const { customer, isLoading } = useAuth();
  const [Modal, setModal] = useState<Modal | null>(null);
  const [opening, setOpening] = useState<Event | null>(null);

  const mount = useCallback(() => {
    void loadModal().then(
      (m) => setModal(() => m.default),
      (error: unknown) => reloadForVersionSkew(error),
    );
  }, []);

  useEffect(() => {
    if (Modal) return;
    const arm = (event: Event) => {
      setOpening(event);
      mount();
    };
    window.addEventListener('polycards:auth', arm);
    return () => window.removeEventListener('polycards:auth', arm);
  }, [Modal, mount]);

  useEffect(() => {
    // AuthModal reads ?auth= itself; it only has to exist.
    if (new URLSearchParams(window.location.search).has('auth')) mount();
  }, [mount]);

  useEffect(() => {
    if (isLoading || customer) return;
    const id = window.setTimeout(
      () => void loadModal().catch(() => {}),
      WARM_AFTER_MS,
    );
    return () => window.clearTimeout(id);
  }, [isLoading, customer]);

  return Modal ? <Modal opening={opening} /> : null;
}
