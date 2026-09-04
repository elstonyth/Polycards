import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPublicProfile } from '@/lib/data/profiles';
import { getAvatarFrames } from '@/lib/data/avatar-frames';
import { toProfileView } from '@/lib/profile-view';
import ProfileClient from './ProfileClient';
import { tabFromParam } from './tabs';

// Public profiles. The param is the collector's DISPLAY NAME — that is the
// whole identity now (see backend utils/profile-handle.ts): rename yourself and
// this URL moves with you, because there is no second stored handle to drift
// out of step with the name.
//
// An unknown name is a 404, full stop. It used to render a deterministic MOCK
// persona so that "every /profile/<user> URL keeps rendering", and that is what
// was reported as stale data on 2026-09-04: /profile/MOONBREON returned 200
// with an invented collector, and so did /profile/ThisAccountDoesNotExist12345.
// Nothing had been left behind in the database — the page was fabricating a
// profile for any string anybody typed. A public page that invents a person is
// worse than a missing one, so the fallback is gone rather than narrowed.
//
// Dynamic (no generateStaticParams): profiles change with every pull.
//
// The param arrives already percent-decoded (Next's route matcher decodes each
// segment), so it is used as-is: a second decodeURIComponent turned a literal
// `%` (/profile/%25) into a URIError → 500 where a 404 was meant.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ user: string }>;
}): Promise<Metadata> {
  const { user: handle } = await params;
  const result = await getPublicProfile(handle); // cache()d — shared with the page
  // Metadata must never throw, and it must never name a profile we are not
  // showing. `notfound` no longer has a persona to borrow a name from, and
  // `unavailable`/`error` are real players we are hiding or failed to load —
  // putting a name in either title is the mistake the 410 exists to prevent.
  if (result.status !== 'ok') {
    return {
      title:
        result.status === 'notfound'
          ? 'Profile not found'
          : 'Profile unavailable',
      description: 'This profile is not available.',
    };
  }
  const name = result.profile.name;
  return {
    title: name,
    description: `${name}'s collection on Polycards.`,
  };
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ user: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ user: handle }, { tab }] = await Promise.all([params, searchParams]);
  const [result, avatarFrames] = await Promise.all([
    getPublicProfile(handle),
    getAvatarFrames(),
  ]);
  // A real 404: nobody holds this display name (or the holder renamed and this
  // is their old URL). Next's own not-found page, with its 404 status — an
  // invented collector is not an acceptable substitute for one.
  if (result.status === 'notfound') {
    notFound();
  }
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
  const view = toProfileView(result.profile, avatarFrames);
  return <ProfileClient user={view} initialTab={tabFromParam(tab)} />;
}
