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
//
// The param arrives already percent-decoded (Next's route matcher decodes
// each segment), so it is used as-is: a second decodeURIComponent turned a
// literal `%` (/profile/%25) into a URIError → 500 where a 404 was meant.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ user: string }>;
}): Promise<Metadata> {
  const { user: handle } = await params;
  const result = await getPublicProfile(handle); // cache()d — shared with the page
  // Metadata must never throw, and the mock persona's name is only ever correct
  // for `notfound` — the one status where the handle really is a mock-pool
  // username. `unavailable` is a real player we are hiding, and `error` is a
  // real player we simply could not load; putting a fabricated name in either
  // title is the same mistake the 410 exists to prevent, and it would also
  // contradict the body, which says "couldn't load this profile" for `error`.
  if (result.status !== 'ok' && result.status !== 'notfound') {
    return {
      title: 'Profile unavailable',
      description: 'This profile is not available.',
    };
  }
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
  const { user: handle } = await params;
  const [result, avatarFrames] = await Promise.all([
    getPublicProfile(handle),
    getAvatarFrames(),
  ]);
  // A transient backend failure must NOT fall through to the mock persona —
  // that would render a fabricated collector under this handle's real name.
  // Only a genuine 404 (unknown/legacy handle) keeps the deterministic mock.
  if (result.status === 'error' || result.status === 'unavailable') {
    // Two states, one card, different copy: `error` is our fault and worth
    // retrying; `unavailable` is a real handle we are deliberately hiding (a
    // disabled account), so it must not invite a retry or hint at why.
    const unavailable = result.status === 'unavailable';
    return (
      <div className="mx-auto w-full px-fluid py-16">
        <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-neutral-900 px-6 py-12 text-center">
          <h1 className="font-heading text-2xl text-white">
            {unavailable ? 'Profile unavailable' : "Couldn't load this profile"}
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            {unavailable
              ? 'This profile is not available.'
              : 'Something went wrong on our end. Please try again in a moment.'}
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
