import { store } from '@/lib/store';
import { cachedJson } from '@/lib/ttl-cache';
import { LuckyDrawStatusSchema } from '@/lib/data/schemas';

// Same-origin endpoint behind the Draw tab's dot and the draw popup, which every
// signed-in tab reads about once a minute. One body per process per window, so
// that costs one backend call however many tabs are open. No identity in it.
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 10_000;

export async function GET() {
  try {
    return await cachedJson('lucky-draw-status', CACHE_TTL_MS, async () => {
      const r = await store.get(
        '/store/lucky-draw-status',
        LuckyDrawStatusSchema,
        { auth: 'none' },
      );
      // A failed read isn't memoised: the next tab tries again.
      if (!r.ok) throw new Error('lucky-draw-status unavailable');
      return {
        latest_gate_at: r.data.latest_gate_at ?? null,
        upcoming: r.data.upcoming ?? [],
      };
    });
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
}
