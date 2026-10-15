import { NextResponse } from 'next/server';
import { store } from '@/lib/store';
import { UncheckedSchema } from '@/lib/data/schemas';

// Same-origin heartbeat for the admin Dashboard's "online now": AuthProvider
// posts here while a signed-in tab is visible, and this forwards it with the
// session's bearer to POST /store/presence (no cookie, no network hop). Best
// effort: the answer is always 204, whatever the backend said.
export async function POST() {
  await store.post('/store/presence', UncheckedSchema, {});
  return new NextResponse(null, { status: 204 });
}
