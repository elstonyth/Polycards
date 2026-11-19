'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { PackPageData } from '@/lib/data/pack-page';
import PackDetailClient from './PackDetailClient';

/** How long a fetched pack is reused: long enough for a hover to pay for the
 *  click that follows, short enough that a price is never a minute old. */
const FRESH_MS = 20_000;

/**
 * The pack a path names, or null when it is not a pack page's address. The
 * address is not always this page's own: a card opened from the page puts
 * /card/<handle> there while the page stays underneath (CardDetailOverlay), and
 * that must never be read as a pack to fetch.
 */
export const packSlugOf = (pathname: string): string | null => {
  const match = /^\/slots\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

async function fetchPackPage(id: string): Promise<PackPageData> {
  const res = await fetch(`/api/pack-page/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`pack page ${res.status}`);
  const data = (await res.json()) as PackPageData;
  // An answer this build can't draw (a deploy landed mid-visit) is a failure:
  // the caller then loads the pack's page the ordinary way.
  if (
    data?.pack?.id !== id ||
    !Array.isArray(data.siblings) ||
    !Array.isArray(data.recentPulls?.pulls)
  ) {
    throw new Error('pack page shape');
  }
  return data;
}

const titleBase = (data: PackPageData) =>
  `${data.pack.name} — ${data.pack.categoryName}`;

/**
 * The pack page with its picker switching packs IN PLACE.
 *
 * Each pack still has its own address, and a tile is still a real link (open in
 * a new tab, copy, share and reload all work). But a plain click on a tile or a
 * category tab no longer loads that address as a new page (loading skeleton,
 * every section rebuilt, focus dropped, the phone view jumping): it fetches the
 * pack's data, then moves the address with `history.pushState`, and the page
 * that is already on screen redraws with the new pack.
 *
 * The ADDRESS still owns which pack is shown (the rule from #571: the address
 * bar, shared links and Back must always describe the pack on screen). The
 * pack drawn is the one the path names, so Back and Forward walk the switches;
 * the server's own data wins for the pack the page was loaded on.
 *
 * Never worse than a page load: if the fetch fails, the click falls back to an
 * ordinary navigation.
 */
export default function PackPage({
  initial,
  initialQty,
}: {
  initial: PackPageData;
  initialQty: number;
}) {
  const router = useRouter();
  const slug = packSlugOf(usePathname());
  const [fetched, setFetched] = useState<Record<string, PackPageData>>({});
  const known =
    slug === null
      ? undefined
      : slug === initial.pack.id
        ? initial
        : fetched[slug];
  // The address can run ahead of the data (Back to a pack whose data is not
  // held), or name no pack at all (a card open over the page): the last pack
  // stays up.
  const [last, setLast] = useState(initial);
  if (known && known !== last) setLast(known);
  const shown = known ?? last;
  const shownId = shown.pack.id;

  const [pending, setPending] = useState<{
    id: string;
    categoryId?: string;
  } | null>(null);
  const loads = useRef(
    new Map<string, { at: number; data: Promise<PackPageData> }>(),
  );
  const turn = useRef(0);

  // One request per pack while it is fresh: a hover and the click after it
  // share it.
  const load = useCallback((id: string) => {
    const held = loads.current.get(id);
    if (held && Date.now() - held.at < FRESH_MS) return held.data;
    const data = fetchPackPage(id);
    loads.current.set(id, { at: Date.now(), data });
    data.catch(() => {
      if (loads.current.get(id)?.data === data) loads.current.delete(id);
    });
    return data;
  }, []);

  const intent = useCallback(
    (id: string) => {
      if (id !== shownId) void load(id);
    },
    [load, shownId],
  );

  const pick = useCallback(
    (id: string, href: string, categoryId?: string) => {
      if (id === shownId) return;
      // The latest click wins: an earlier pack that answers late is dropped.
      const mine = ++turn.current;
      setPending({ id, categoryId });
      load(id).then(
        (data) => {
          if (turn.current !== mine) return;
          setFetched((held) => ({ ...held, [id]: data }));
          setPending(null);
          // Next's router follows a native history move: the path (read above)
          // and the search params update without a request to the server.
          window.history.pushState(null, '', href);
        },
        () => {
          if (turn.current !== mine) return;
          setPending(null);
          router.push(href, { scroll: false });
        },
      );
    },
    [load, router, shownId],
  );

  // An address whose pack is not held (Back or Forward past a reload): fetch
  // it; if that fails, let the server answer for the address.
  useEffect(() => {
    if (known || slug === null) return;
    let live = true;
    load(slug).then(
      (data) => {
        if (live) setFetched((held) => ({ ...held, [slug]: data }));
      },
      () => {
        if (live) window.location.reload();
      },
    );
    return () => {
      live = false;
    };
  }, [known, slug, load]);

  // The tab's title is the server's for the pack the page loaded on. A switch
  // keeps its wording (whatever follows the pack and category) and renames it.
  const titleTail = useRef<string | null>(null);
  useEffect(() => {
    if (titleTail.current === null) {
      const loaded = titleBase(initial);
      titleTail.current = document.title.startsWith(loaded)
        ? document.title.slice(loaded.length)
        : ' · Polycards';
    }
    document.title = titleBase(shown) + titleTail.current;
  }, [shown, initial]);

  return (
    <PackDetailClient
      pack={shown.pack}
      siblings={shown.siblings}
      categoryTabs={shown.categoryTabs}
      detail={shown.detail}
      recentPulls={shown.recentPulls}
      initialQty={initialQty}
      freePackEligible={shown.freePackEligible}
      freePackMissing={shown.freePackMissing}
      onPick={pick}
      onIntent={intent}
      pendingPack={pending?.id ?? null}
      pendingCategory={pending?.categoryId ?? null}
    />
  );
}
