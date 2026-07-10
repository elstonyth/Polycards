import type { Metadata } from 'next';
import { userOrGeneric } from '@/lib/mock/users';
import { getPublicProfile } from '@/lib/data/profiles';
import { getAvatarFrames } from '@/lib/data/avatar-frames';
import { mockProfileView, toProfileView } from '@/lib/profile-view';
import ProfileClient from './ProfileClient';

// Real public profiles (Task B): the param is a collector handle resolved via
// GET /store/profiles/:handle (safe-public subset, no PII). Unknown handles —
// mock-pool usernames, dead links — fall back to the deterministic mock pool
// so every /profile/<user> URL keeps rendering, exactly as before. Dynamic
// now (no generateStaticParams): profiles change with every pull.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ user: string }>;
}): Promise<Metadata> {
  const { user } = await params;
  const handle = decodeURIComponent(user);
  const profile = await getPublicProfile(handle); // cache()d — shared with the page
  const name = profile?.name ?? userOrGeneric(handle).username;
  return {
    title: name,
    description: `${name}'s collection on PixelSlot.`,
  };
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ user: string }>;
}) {
  const { user } = await params;
  const handle = decodeURIComponent(user);
  const [profile, avatarFrames] = await Promise.all([
    getPublicProfile(handle),
    getAvatarFrames(),
  ]);
  const view = profile
    ? toProfileView(profile, avatarFrames)
    : mockProfileView(userOrGeneric(handle));
  return <ProfileClient user={view} />;
}
