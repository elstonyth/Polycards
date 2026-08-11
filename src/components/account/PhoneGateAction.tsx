'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { isPhoneGateError } from '@/lib/phone-gate';
import { pillVariants } from '@/components/ui/pill';

/**
 * The way OUT of the phone gate, rendered under the error it belongs to.
 *
 * The mapped copy already names Account settings, but a customer stopped
 * mid-top-up (or mid-delivery) has to leave the sheet, find /me, find
 * Settings, and find the Add button — four steps of prose. This is the same
 * instruction as a control.
 *
 * `onNavigate` exists because two of the three call sites are modals with
 * their own open state: without it the sheet stays overlaid on /settings after
 * the navigation. Renders nothing for every other error.
 */
export function PhoneGateAction({
  error,
  onNavigate,
}: {
  error: string | null;
  onNavigate?: () => void;
}) {
  if (!error || !isPhoneGateError(error)) return null;
  return (
    <Link
      href="/settings"
      onClick={onNavigate}
      // secondary, not primary: this sits directly above each surface's own
      // white full-width CTA (Pay / Request delivery / Withdraw), and two
      // identical primaries compete instead of reading as an escape hatch.
      className={cn(
        pillVariants({ variant: 'secondary', size: 'sm' }),
        'mt-2 w-full',
      )}
    >
      Add your phone number
    </Link>
  );
}
