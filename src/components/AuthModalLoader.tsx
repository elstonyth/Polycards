'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useAuth } from '@/components/auth/AuthProvider';

const loadModal = () => import('@/components/AuthModal');
const AuthModal = dynamic(loadModal, { ssr: false });

/** A guest who has stayed this long gets the form warmed, so Join opens at once. */
const WARM_AFTER_MS = 6_000;

/**
 * Keeps the signup form and its phone library (~120 KB of parsed JS) off every
 * page: AuthModal mounts on the first openAuth() or ?auth= arrival, and the
 * event that triggered the load is handed over because it has already fired.
 */
export default function AuthModalLoader() {
  const { customer, isLoading } = useAuth();
  const [mounted, setMounted] = useState(false);
  const [opening, setOpening] = useState<Event | null>(null);

  useEffect(() => {
    if (mounted) return;
    const arm = (event: Event) => {
      setOpening(event);
      setMounted(true);
    };
    window.addEventListener('polycards:auth', arm);
    return () => window.removeEventListener('polycards:auth', arm);
  }, [mounted]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('auth')) {
      // AuthModal reads ?auth= itself; it only has to exist.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
    }
  }, []);

  useEffect(() => {
    if (isLoading || customer) return;
    const id = window.setTimeout(() => void loadModal(), WARM_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [isLoading, customer]);

  return mounted ? <AuthModal opening={opening} /> : null;
}
