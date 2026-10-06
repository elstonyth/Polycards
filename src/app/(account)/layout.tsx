import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getAccountInfo, getCustomer, getRealName } from '@/lib/data/customer';
import { PHONE_VERIFICATION_REQUIRED } from '@/lib/phone-verification';
import { shouldGatePhone } from '@/lib/phone-gate';
import { PhoneOnboardingModal } from '@/components/account/PhoneOnboardingModal';
import { RealNameModal } from '@/components/account/RealNameModal';

// Shared shell for the account/wallet pages (URLs stay top-level via the route group).
// Gated: unauthenticated visitors are bounced home with ?auth=login, which the
// header's AuthModal picks up and opens (there is no standalone /login page).
// Nav lives in the Me tab + bottom TabBar now — no sidebar chrome.
export default async function AccountLayout({
  children,
}: {
  children: ReactNode;
}) {
  const customer = await getCustomer();
  if (!customer) redirect('/?auth=login');

  // A phone is required to hold an account (operator decision 2026-09-08). The
  // emailpass form collects and verifies one at signup; a first Google login
  // is the one path that arrives without one, so gate every account page
  // until it is verified — existing phoneless Google accounts meet it on their
  // next visit here. Only the password-less cohort: the change route asks a
  // password account for its password before it will add a phone, and the
  // gate has no field for it — those (legacy, pre-enforcement) rows keep the
  // Settings flow and the /me tile highlight. Enforcement off means no phone
  // gate here (signups may then carry unproven numbers).
  //
  // Scope: the ACCOUNT tree. A gated player can still browse /, /slots and
  // /task and open the top-up sheet; the money and goods paths refuse them at
  // the backend (requirePhoneVerified) and PhoneGateAction sends them to
  // /settings, where this waits. The modal is UX, the backend gates are the
  // enforcement — which is also why a failed account read (reported as
  // hasPassword: true) fails OPEN here instead of raising a gate a password
  // account could never complete.
  // Both thunks read the same request-cached getAccountInfo — one round trip.
  const gatePhone = await shouldGatePhone({
    flag: PHONE_VERIFICATION_REQUIRED,
    phone: customer.phone,
    hasPassword: async () => (await getAccountInfo()).hasPassword,
    exempt: async () => (await getAccountInfo()).policy.verificationExempt,
  });

  // Real-name gate (spec 2026-10-06): EVERY account without a real name on
  // file, old ones included — not just a cohort. Only after the phone gate,
  // never stacked on it: two non-dismissable dialogs would fight over focus,
  // and the phone comes first. `realName === null` is a positive "none on
  // file"; an unreadable answer is `undefined` and raises nothing (fail-open,
  // like the phone gate — the welcome-pack claim refuses at the backend).
  // Partner groups with `verification_exempt` skip it, as they skip the phone.
  // The name is a one-row read (getRealName); the four-read account facts are
  // fetched only for the rare account that has none, to check the exemption.
  const realName = gatePhone ? undefined : await getRealName();
  const gateRealName =
    realName === null && !(await getAccountInfo()).policy.verificationExempt;

  return (
    <div className="mx-auto w-full max-w-2xl px-fluid py-6 lg:max-w-4xl">
      {children}
      {gatePhone && <PhoneOnboardingModal />}
      {gateRealName && <RealNameModal />}
    </div>
  );
}
