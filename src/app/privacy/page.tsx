import type { Metadata } from 'next';
import Reveal from '@/components/Reveal';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'What Polycards collects, why, and how to reach us about your data.',
};

// v1 policy written from what the product actually does (auth cookies,
// consent-gated Meta Pixel, GlobePay payments, Resend transactional email,
// Twilio Verify SMS, the public Telegram pull broadcast, DigitalOcean
// hosting). Operator should review wording before any formal legal reliance;
// keep this page in sync when data practices change.
//
// Reviewed 2026-08-26: added the mandatory phone + SMS verification and the
// public-activity/Telegram disclosure. The Telegram broadcast
// (modules/packs/telegram.ts) has an ADMINISTRATIVE disable only, no customer
// opt-out — the copy says what is true rather than promising a control that
// does not exist. Adding one is a product decision, not a copy edit.

const SECTIONS: { title: string; body: string }[] = [
  {
    title: 'What we collect',
    body: 'Your account details (email, mobile phone number, display handle), your pack, vault, and transaction history, and the technical basics every web service receives — IP address and browser information. A mobile number is required to open and keep an account: we verify it by SMS at signup, and again if you change it or reset your password. If you sign in with Google, we receive your name and email from Google.',
  },
  {
    title: 'Cookies',
    body: 'We use cookies to keep you signed in and to remember choices like your referral invite. Analytics cookies (Meta Pixel) are set only if you accept them in the cookie banner — rejecting them keeps the site fully functional.',
  },
  {
    title: 'Payments',
    body: 'Card and payment details are handled by our payment providers. Polycards never sees or stores your card number.',
  },
  {
    title: 'Email and SMS',
    body: 'We send transactional messages only — password resets, verification codes, and account notices — from send.polycards.gg by email and by SMS to your mobile number. A third-party messaging provider delivers them, so your email address and mobile number are shared with that provider for that purpose. We do not sell or share either for marketing.',
  },
  {
    title: 'Public activity',
    body: 'Polycards is partly a public product. Your display name is shown on public surfaces — the leaderboard, the weekly challenge, the recent-pulls feed on the home and pack pages, and your public profile page, whose web address contains your handle. Notable pulls are also announced automatically to our public Telegram channel, with your display name and a link to that profile. This is on by default for every account. We never publish your email address, your mobile number, or your account balance.',
  },
  {
    title: 'Where your data lives',
    body: 'Data is stored with our hosting provider (DigitalOcean, Singapore region) and retained while your account is active.',
  },
  {
    title: 'Your choices',
    body: 'You can ask us to export or delete your account data at any time. Email support@polycards.gg and we will handle it.',
  },
];

export default function PrivacyPage() {
  return (
    <div className="w-full px-fluid py-10">
      <Reveal
        as="h1"
        className="font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl"
      >
        Privacy Policy
      </Reveal>
      <Reveal
        as="p"
        delay={80}
        className="mt-4 max-w-4xl text-sm leading-relaxed text-white/55"
      >
        The short version: we collect what the product needs to run, nothing
        more. No selling of personal data, no third-party marketing lists, and
        analytics only with your consent.
      </Reveal>

      <div className="mt-8 flex max-w-3xl flex-col gap-3">
        {SECTIONS.map((s, i) => (
          <Reveal key={s.title} delay={120 + i * 60}>
            <section className="rounded-2xl border border-white/10 bg-neutral-900 p-4">
              <h2 className="font-heading text-base text-white">{s.title}</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                {s.body}
              </p>
            </section>
          </Reveal>
        ))}
      </div>

      <Reveal
        as="p"
        delay={160}
        className="mt-8 max-w-3xl text-[13px] leading-relaxed text-neutral-400"
      >
        Questions about your data? Contact{' '}
        <a
          href="mailto:support@polycards.gg"
          className="text-neutral-300 underline-offset-2 hover:underline"
        >
          support@polycards.gg
        </a>
        .
      </Reveal>
    </div>
  );
}
