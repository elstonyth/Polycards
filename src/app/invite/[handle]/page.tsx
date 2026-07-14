import type { Metadata } from 'next';
import InviteClient from './InviteClient';

// The param arrives URI-encoded — decode it for the title and the client
// (mirrors /profile/[user]).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  return { title: `Join ${decodeURIComponent(handle)} on Polycards` };
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return <InviteClient handle={decodeURIComponent(handle)} />;
}
