import HeroSection from '@/components/HeroSection';
import OpenPacksSection from '@/components/OpenPacksSection';
import RecentPullsSection from '@/components/RecentPullsSection';
import HowItWorksSection from '@/components/HowItWorksSection';
import CommunitySection from '@/components/CommunitySection';
import LeaderboardSection from '@/components/LeaderboardSection';
import CtaSection from '@/components/CtaSection';
import Reveal from '@/components/Reveal';

export default function Home() {
  return (
    <div className="mx-auto w-full px-fluid py-4">
      <HeroSection />
      <Reveal>
        <OpenPacksSection />
      </Reveal>
      <Reveal>
        <RecentPullsSection />
      </Reveal>
      {/* HowItWorksSection has its own internal scroll-in animation */}
      <HowItWorksSection />
      <Reveal>
        <CommunitySection />
      </Reveal>
      {/* LeaderboardSection has its own staggered row-reveal on scroll-in.
          `live` swaps the mock teaser for the live weekly board on mount
          (keeps this page statically rendered; see /api/leaderboard). */}
      <LeaderboardSection live />
      <Reveal>
        <CtaSection />
      </Reveal>
    </div>
  );
}
