import type { Metadata } from 'next';
import AchievementsClient from './AchievementsClient';

export const metadata: Metadata = {
  title: 'Achievements',
  description:
    'Level up your collecting journey. Earn XP, unlock perks, and showcase your dedication across every achievement tier.',
};

export default function AchievementsPage() {
  return <AchievementsClient />;
}
