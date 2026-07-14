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
  const result = await getPublicProfile(handle); // cache()d — shared with the page
  // Metadata must never throw: treat error the same as notfound (generic name).
  const name =
    result.status === 'ok'
      ? result.profile.name
      : userOrGeneric(handle).username;
  return {
    title: name,
    description: `${name}'s collection on Polycards.`,
  };
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ user: string }>;
}) {
  const { user } = await params;
  const handle = decodeURIComponent(user);
  const [result, avatarFrames] = await Promise.all([
    getPublicProfile(handle),
    getAvatarFrames(),
  ]);
  // A transient backend failure must NOT fall through to the mock persona —
  // that would render a fabricated collector under this handle's real name.
  // Only a genuine 404 (unknown/legacy handle) keeps the deterministic mock.
  if (result.status === 'error') {
    return (
      <div className="mx-auto w-full px-fluid py-16">
        <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-neutral-900 px-6 py-12 text-center">
          <h1 className="font-heading text-2xl text-white">
            Couldn&apos;t load this profile
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            Something went wrong on our end. Please try again in a moment.
          </p>
        </div>
      </div>
    );
  }
  const view =
    result.status === 'ok'
      ? toProfileView(result.profile, avatarFrames)
      : mockProfileView(userOrGeneric(handle));
  return <ProfileClient user={view} />;
}
