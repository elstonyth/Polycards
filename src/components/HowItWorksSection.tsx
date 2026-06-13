import HowItWorksSteps from '@/components/HowItWorksSteps';

/**
 * Homepage "How It Works" teaser: heading row (left title + "Learn more" link)
 * over the shared 3-step cards. The cards live in HowItWorksSteps so they stay
 * identical to the /how-it-works page.
 */
export default function HowItWorksSection() {
  return (
    <section className="mt-10 sm:mt-14">
      <div className="mb-5 flex items-end justify-between gap-4 sm:mb-6">
        <h2 className="font-heading bg-gradient-to-b from-white via-white/80 to-white/30 bg-clip-text text-2xl font-bold tracking-tight text-transparent">
          How It Works
        </h2>
        <a
          href="/how-it-works"
          className="shrink-0 text-[12px] font-medium text-white/45 transition-colors hover:text-white/60 sm:text-sm"
        >
          Learn more about us →
        </a>
      </div>
      <HowItWorksSteps />
    </section>
  );
}
