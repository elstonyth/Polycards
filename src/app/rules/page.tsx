import type { Metadata } from 'next';
import Reveal from '@/components/Reveal';

export const metadata: Metadata = {
  title: 'Fair Play Rules',
  description:
    'One account per person, one welcome pack per household, and how withdrawals are checked.',
};

// The account and reward rules customers agree to, in the plain form other
// collectibles and card sites publish (owner 2026-11-17: "follow other
// websites' rules so customers don't complain"). Written from what the code
// does: one bank per account (ADR 0015), the welcome pack's gates and its one
// per household rule, the spend-first and bonus rules (ADR 0012, 0013), and
// the review holds (ADR 0018). Keep it in sync when any of those change.
const SECTIONS: { title: string; body: string }[] = [
  {
    title: 'One person, one account',
    body: 'Each person may have one Polycards account. The phone number, real name and bank account on it must be your own. A bank account can be used by one Polycards account only.',
  },
  {
    title: 'The welcome pack',
    body: 'The free welcome pack is one per person or household. To claim it, verify your phone number, add your real name and add your bank account. If an account in your household has already claimed it on the same device, another account cannot claim it again.',
  },
  {
    title: 'Withdrawing',
    body: 'Top up at least once, and use your top-ups on packs, before you withdraw. Bonus credit is for packs only and cannot be withdrawn. Withdrawals are paid to a bank account in your own real name.',
  },
  {
    title: 'Checks before a payout',
    body: 'Some withdrawals are checked by our team before they are sent, such as large amounts, or a withdrawal from an account used on the same device as another account. During the check the amount is set aside, and it returns to your balance if the withdrawal is not approved. If your family shares a device, contact customer service: once we confirm you are separate people in one household, later withdrawals are not held for that reason.',
  },
  {
    title: 'Not allowed',
    body: 'Running more than one account, using someone else’s bank account or phone number, or using scripts or other tools to collect free rewards. Accounts involved may be closed, and rewards gained this way, and money made from them, may be withheld.',
  },
  {
    title: 'Changes',
    body: 'We may update these rules. The current version is always on this page.',
  },
];

export default function RulesPage() {
  return (
    <div className="w-full px-fluid py-10">
      <Reveal
        as="h1"
        className="font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl"
      >
        Fair Play Rules
      </Reveal>
      <Reveal
        as="p"
        delay={80}
        className="mt-4 max-w-4xl text-sm leading-relaxed text-white/55"
      >
        The short version: one account per person, one welcome pack per
        household, and withdrawals to your own bank.
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
        Questions about these rules? Contact{' '}
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
