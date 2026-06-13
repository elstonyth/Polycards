import type { Metadata } from 'next';
import Reveal from '@/components/Reveal';

export const metadata: Metadata = {
  title: 'Your Fairness Proofs — Phygitals',
  description: 'Verify the provably-fair selection proofs for your pulls.',
};

// Matches the live phygitals /fairness for an anonymous visitor: a heading + the
// commit-reveal explainer, then a "Failed to load proofs" data wall (proofs are
// per-account and require auth). We intentionally do NOT fabricate proof rows —
// the live site exposes none to anonymous users.

export default function FairnessPage() {
  return (
    <div className="w-full px-fluid py-10">
      <Reveal
        as="h1"
        className="font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl"
      >
        Your Fairness Proofs
      </Reveal>
      <Reveal
        as="p"
        delay={80}
        className="mt-4 max-w-4xl text-sm leading-relaxed text-white/55"
      >
        This page shows your last 100 selection proofs. Each proof contains a
        serverSeedHash (commitment), the revealed serverSeed, your clientSeed
        (session), and deterministic selection details. Anyone can verify
        reproducibility using the seeds and sorting rule described below.
      </Reveal>
      <Reveal
        as="p"
        delay={140}
        className="mt-8 text-sm font-medium text-red-500"
      >
        Failed to load proofs
      </Reveal>
    </div>
  );
}
