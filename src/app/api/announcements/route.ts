import { getAnnouncements } from '@/lib/data/announcements';

// Same-origin endpoint the announcement popup fetches once per page load. A
// direct Store-API call from the browser would be CORS-blocked, and fetching in
// the root layout instead baked a copy of the set into every prerendered page
// (stale on the static ones, and two copies of different ages could flap the
// popup). getAnnouncements memoises the backend hop for 60s per process, so
// this costs one backend call a minute however many visitors load pages.
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ announcements: await getAnnouncements() });
}
